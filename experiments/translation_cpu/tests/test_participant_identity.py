"""Participant connection identities, including rejoin in the same room session.

Tiny control engines only. These tests do not infer or establish model quality.
"""
import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streaming_adapter import (
    BackpressureError, ParticipantHandle, StaleFrameError, TranslationStreamAdapter,
)

class ParticipantIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.block = False
        self.results = []
        async def asr(audio, language):
            self.started.set()
            if self.block:
                await self.release.wait()
            return audio.decode()
        async def mt(text, source, target):
            return text
        self.adapter = TranslationStreamAdapter(asr, mt, on_result=self.results.append)

    async def asyncTearDown(self):
        self.release.set()
        await self.adapter.close()

    def participant(self, name="same-id"):
        return self.adapter.register_participant(name, session=self.adapter.session)

    def track(self, participant, track="mic"):
        return self.adapter.register_track(participant, track, "en", "ru")

    async def submit(self, track, sequence=1, audio=b"fresh"):
        return await self.adapter.submit(track, audio, sequence=sequence, duration_seconds=.1)

    async def test_delayed_old_leave_cannot_remove_rejoined_participant(self):
        old = self.participant()
        old_track = self.track(old)
        self.assertEqual(self.adapter.participant_left(old), 1)
        fresh = self.participant()
        fresh_track = self.track(fresh)
        self.assertIs(fresh.session, old.session)
        self.assertNotEqual(fresh.generation, old.generation)
        self.assertEqual(self.adapter.participant_left(old), 0)
        self.assertTrue(self.adapter.is_current(fresh_track))
        self.assertFalse(self.adapter.is_current(old_track))
        self.assertEqual((await (await self.submit(fresh_track))).source_text, "fresh")

    async def test_delayed_leave_during_new_work_preserves_active_and_queued_results(self):
        old = self.participant()
        self.track(old)
        self.adapter.participant_left(old)
        fresh = self.participant()
        fresh_track = self.track(fresh)
        self.block = True
        active = await self.submit(fresh_track, 1, b"first")
        await self.started.wait()
        queued = await self.submit(fresh_track, 2, b"second")
        self.assertEqual(self.adapter.participant_left(old), 0)
        self.assertFalse(active.cancelled())
        self.assertFalse(queued.cancelled())
        self.release.set()
        self.assertEqual([result.source_text for result in await asyncio.gather(active, queued)], ["first", "second"])
        self.assertEqual([result.source_text for result in self.results], ["first", "second"])

    async def test_track_replacement_preserves_connection_and_current_leave_cancels_all(self):
        participant = self.participant()
        old_track = self.track(participant)
        self.adapter.unregister_track(old_track)
        self.assertTrue(self.adapter.is_current_participant(participant))
        fresh_track = self.track(participant)
        screen = self.track(participant, "screen")
        self.assertIs(fresh_track.participant, participant)
        self.assertFalse(self.adapter.unregister_track(old_track))
        self.block = True
        active = await self.submit(fresh_track)
        await self.started.wait()
        queued = await self.submit(screen)
        self.assertEqual(self.adapter.participant_left(participant), 2)
        self.assertTrue(active.cancelled())
        self.assertTrue(queued.cancelled())
        self.assertFalse(self.adapter.is_current_participant(participant))
        self.assertEqual(self.adapter.stats["tracks"], 0)
        self.assertEqual(self.adapter.stats["participants"], 0)

    async def test_stale_and_forged_participants_cannot_register_or_remove_tracks(self):
        old = self.participant()
        self.track(old)
        self.adapter.participant_left(old)
        fresh = self.participant()
        track = self.track(fresh)
        forged = ParticipantHandle(fresh.session, fresh.participant_id, fresh.generation)
        for stale in (old, forged, fresh.participant_id, None):
            with self.subTest(token=type(stale).__name__):
                self.assertFalse(self.adapter.is_current_participant(stale))
                self.assertEqual(self.adapter.participant_left(stale), 0)
                with self.assertRaises(StaleFrameError):
                    self.track(stale, "must-not-register")
                self.assertTrue(self.adapter.is_current(track))
        with self.assertRaises(TypeError):
            self.adapter.participant_left(fresh.session, fresh.participant_id)
        with self.assertRaises(ValueError):
            self.participant()

    async def test_participant_cap_counts_idle_connections_and_leave_releases_it(self):
        self.adapter._limits["max_participants"] = 1
        participant = self.participant()
        with self.assertRaises(BackpressureError):
            self.participant("other")
        self.assertEqual(self.adapter.participant_left(participant), 0)
        for _ in range(1000):
            fresh = self.participant()
            self.assertEqual(self.adapter.stats["participants"], 1)
            self.assertEqual(self.adapter.participant_left(participant), 0)
            self.assertTrue(self.adapter.is_current_participant(fresh))
            self.adapter.participant_left(fresh)
            participant = fresh
        self.assertEqual(self.adapter.stats["participants"], 0)
        other = self.participant("other")
        self.assertTrue(self.adapter.is_current_participant(other))
        self.adapter.reconnect(self.adapter.session)
        self.assertEqual(self.adapter.stats["participants"], 0)
        self.assertFalse(self.adapter.is_current_participant(other))

    async def test_room_close_invalidates_participants_without_tracks(self):
        participant = self.participant()
        await self.adapter.close()
        self.assertFalse(self.adapter.is_current_participant(participant))
        self.assertEqual(self.adapter.stats["participants"], 0)
        self.assertEqual(self.adapter.participant_left(participant), 0)

if __name__ == "__main__":
    unittest.main()
