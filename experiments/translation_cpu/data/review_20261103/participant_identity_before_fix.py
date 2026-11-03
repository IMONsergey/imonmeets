"""Regressions for participant rejoin within an unchanged room session."""
import asyncio
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from streaming_adapter import TranslationStreamAdapter

class ParticipantIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_delayed_old_leave_cannot_remove_rejoined_participant(self):
        async def asr(audio, language):
            return audio.decode()
        async def mt(text, source, target):
            return text
        adapter = TranslationStreamAdapter(asr, mt)
        try:
            session = adapter.session
            old = adapter.register_track("same-id", "mic", "en", "ru", session=session)
            self.assertEqual(adapter.participant_left(session, "same-id"), 1)
            fresh = adapter.register_track("same-id", "mic", "en", "ru", session=session)
            self.assertIs(fresh.session, session)
            # A delayed duplicate from the old participant connection must be harmless.
            self.assertEqual(adapter.participant_left(session, "same-id"), 0)
            self.assertTrue(adapter.is_current(fresh))
            self.assertFalse(adapter.is_current(old))
            future = await adapter.submit(fresh, b"fresh", sequence=1, duration_seconds=.1)
            self.assertEqual((await future).source_text, "fresh")
        finally:
            await adapter.close()

if __name__ == "__main__":
    unittest.main()
