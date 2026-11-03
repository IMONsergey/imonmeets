"""Actual OS workers and real engine wrappers, with a tiny protocol fixture.

No model weights, speech-quality assertion, TTS, network or production connection.
The unchanged model benchmarks remain the source for ASR/MT quality measurements.
"""
import asyncio
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from process_stage import ProcessStage, StageBusyError, StageCleanupError
from real_engines import ASRProcessEngine, MTProcessEngine
from streaming_adapter import DeadlineError, TranslationStreamAdapter, UnknownTrackError


ECHO = "import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'id':r['id'],'ok':True,'result':r['payload']}),flush=True)"
HANG = "import sys,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsys.stdin.readline()\ntime.sleep(60)"
PROTOCOL_WORKER = r'''
import base64,json,os,pathlib,signal,sys,time
stage,started,late=sys.argv[1:]
for line in sys.stdin:
    request=json.loads(line)
    payload=request['payload']
    text=base64.b64decode(payload['audio_base64']).decode() if stage=='asr' else payload['text']
    if 'HANG_'+stage.upper() in text:
        signal.signal(signal.SIGTERM,signal.SIG_IGN)
        pathlib.Path(started).write_text(str(os.getpid()))
        time.sleep(.6)
        pathlib.Path(late).write_text('forbidden late effect')
    result={'text':text if stage=='asr' else 'translated:'+text,'fixture':True}
    print(json.dumps({'id':request['id'],'ok':True,'result':result}),flush=True)
'''


async def eventually(predicate, timeout=3):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.002)


class StageBoundsTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_reap_keeps_handle_and_budget_and_never_spawns_replacement(self):
        stage = ProcessStage([sys.executable, "-u", "-c", HANG], terminate_grace_seconds=.01,
                             reap_timeout_seconds=.02)
        active = asyncio.create_task(stage.request({"owned": "native-buffer"}))
        await eventually(lambda: stage.pid is not None)
        process, pid = stage._process, stage.pid
        original_wait = process.wait
        reserved = stage.stats["pending_bytes"]
        queued = asyncio.create_task(stage.request({"queued": True}))
        await eventually(lambda: stage.stats["pending"] == 2)
        async def cannot_prove_reap():
            await asyncio.sleep(60)
        process.wait = cannot_prove_reap
        try:
            active.cancel()
            with self.assertRaises(StageCleanupError):
                await active
            await asyncio.gather(queued, return_exceptions=True)
            self.assertTrue(queued.cancelled())
            self.assertIs(stage._process, process)
            self.assertEqual(stage.pid, pid)
            self.assertTrue(stage.stats["closed"])
            self.assertTrue(stage.stats["quarantined"])
            self.assertEqual(stage.stats["pending"], 1)
            self.assertEqual(stage.stats["pending_bytes"], reserved)
            with self.assertRaises(RuntimeError):
                await stage.request({"must_not_spawn": True})
            self.assertIs(stage._process, process)
            with self.assertRaises(StageCleanupError):
                await stage.close()
            self.assertEqual(stage.stats["pending_bytes"], reserved)
        finally:
            process.wait = original_wait
            await stage.close()
        self.assertIsNone(stage.pid)
        self.assertEqual(stage.stats["pending"], 0)
        self.assertEqual(stage.stats["pending_bytes"], 0)
        self.assertFalse(stage.stats["quarantined"])
        with self.assertRaises(RuntimeError):
            await stage.request({"closed_even_after_recovery": True})

    async def test_aggregate_utf8_byte_cap_rejects_before_reserving_or_starting(self):
        stage = ProcessStage([sys.executable, "-u", "-c", HANG], max_pending=4,
                             max_pending_bytes=200, terminate_grace_seconds=.03)
        first = asyncio.create_task(stage.request({"text": "ж" * 30}))
        try:
            await eventually(lambda: stage.pid is not None)
            pid, reserved = stage.pid, stage.stats["pending_bytes"]
            self.assertEqual(reserved, len(json.dumps({"text": "ж" * 30}, ensure_ascii=False, separators=(",", ":")).encode()) + 64)
            with self.assertRaises(StageBusyError):
                await stage.request({"text": "ж" * 30})
            self.assertEqual(stage.stats["pending"], 1)
            self.assertEqual(stage.stats["pending_bytes"], reserved)
            self.assertEqual(stage.pid, pid)
        finally:
            await stage.close()
            await asyncio.gather(first, return_exceptions=True)
        self.assertEqual(stage.stats["pending_bytes"], 0)

    async def test_queue_age_and_explicit_deadline_do_not_kill_active_owner(self):
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                stage = ProcessStage([sys.executable, "-u", "-c", HANG], timeout_seconds=3,
                                     max_queue_seconds=.04 if not explicit else 2,
                                     terminate_grace_seconds=.03)
                first = asyncio.create_task(stage.request({}))
                try:
                    await eventually(lambda: stage.pid is not None)
                    pid = stage.pid
                    kwargs = {"deadline": asyncio.get_running_loop().time() + .04} if explicit else {}
                    with self.assertRaises(TimeoutError):
                        await stage.request({"queued": True}, **kwargs)
                    self.assertEqual(stage.pid, pid)
                    os.kill(pid, 0)
                    self.assertEqual(stage.stats["pending"], 1)
                    self.assertFalse(first.done())
                finally:
                    await stage.close()
                    await asyncio.gather(first, return_exceptions=True)

    async def test_close_cancels_all_waiters_and_survives_cancelled_closer(self):
        stage = ProcessStage([sys.executable, "-u", "-c", HANG], max_pending=4,
                             terminate_grace_seconds=.05)
        calls = [asyncio.create_task(stage.request({"index": 0}))]
        await eventually(lambda: stage.pid is not None)
        pid = stage.pid
        calls.extend(asyncio.create_task(stage.request({"index": i})) for i in range(1, 4))
        await eventually(lambda: stage.stats["pending"] == 4)
        closer = asyncio.create_task(stage.close())
        await eventually(lambda: stage.stats["closed"])
        closer.cancel()
        await asyncio.gather(closer, return_exceptions=True)
        await stage.close()
        await asyncio.gather(*calls, return_exceptions=True)
        self.assertTrue(all(call.cancelled() for call in calls))
        self.assertEqual(stage.stats["pending_bytes"], 0)
        self.assertEqual(stage.stats["pending"], 0)
        self.assertIsNone(stage.pid)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_cancel_during_os_spawn_retains_ownership_until_reaped(self):
        stage = ProcessStage([sys.executable, "-u", "-c", HANG], terminate_grace_seconds=.03)
        original_spawn = asyncio.create_subprocess_exec
        created, release = asyncio.Event(), asyncio.Event()
        spawned = []
        async def delayed_return(*args, **kwargs):
            process = await original_spawn(*args, **kwargs)
            spawned.append(process)
            created.set()
            await release.wait()
            return process
        with patch("process_stage.asyncio.create_subprocess_exec", delayed_return):
            call = asyncio.create_task(stage.request({}))
            await created.wait()
            pid = spawned[0].pid
            call.cancel()
            closer = asyncio.create_task(stage.close())
            await asyncio.sleep(.01)
            release.set()
            await asyncio.gather(call, closer, return_exceptions=True)
        self.assertTrue(call.cancelled())
        self.assertIsNone(stage.pid)
        self.assertEqual(stage.stats["pending_bytes"], 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_descendant_is_stopped_even_if_parent_exits_on_sigterm(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / "late"
            pidfile = pathlib.Path(directory) / "child-pid"
            child = "import pathlib,signal,sys,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(.5);pathlib.Path(sys.argv[1]).write_text('late')"
            parent = "import pathlib,subprocess,sys,time;sys.stdin.readline();p=subprocess.Popen([sys.executable,'-u','-c',sys.argv[1],sys.argv[2]]);pathlib.Path(sys.argv[3]).write_text(str(p.pid));time.sleep(60)"
            stage = ProcessStage([sys.executable, "-u", "-c", parent, child, str(marker), str(pidfile)], terminate_grace_seconds=.03)
            call = asyncio.create_task(stage.request({}))
            try:
                await eventually(pidfile.exists)
                call.cancel()
                await asyncio.gather(call, return_exceptions=True)
                await asyncio.sleep(.55)
                self.assertFalse(marker.exists())
                child_stat = pathlib.Path(f"/proc/{pidfile.read_text()}/stat")
                if child_stat.exists():
                    self.assertIn(child_stat.read_text().split(") ", 1)[1].split()[0], ("Z", "X"))
            finally:
                await stage.close()


class EngineAdapterLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = pathlib.Path(self.temp.name)
        self.asr = ASRProcessEngine(sys.executable, "en")
        self.mt = MTProcessEngine(sys.executable, "en", "ru")
        for name, engine in (("asr", self.asr), ("mt", self.mt)):
            engine.stage.command = (sys.executable, "-u", "-c", PROTOCOL_WORKER, name,
                                    str(self.directory / f"{name}-started"), str(self.directory / f"{name}-late"))
            engine.stage.terminate_grace_seconds = .03
        self.results = []
        self.adapter = TranslationStreamAdapter(self.asr, self.mt, on_result=self.results.append)
        self.handle = self.register()

    def register(self, participant="p", track="mic"):
        return self.adapter.register_track(participant, track, "en", "ru", session=self.adapter.session)

    async def submit(self, handle, sequence, audio, **kwargs):
        return await self.adapter.submit(handle, audio, sequence=sequence, duration_seconds=.1, **kwargs)

    async def asyncTearDown(self):
        await self.adapter.close()
        self.temp.cleanup()

    def assert_reaped(self, pid):
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_room_leave_closes_idle_asr_and_mt_workers_and_clears_results(self):
        future = await self.submit(self.handle, 1, b"hello")
        result = await future
        self.assertEqual((result.source_text, result.translated_text, result.audio), ("hello", "translated:hello", b""))
        self.assertTrue(self.asr.last_result["fixture"])
        pids = [self.asr.stage.pid, self.mt.stage.pid]
        self.assertTrue(all(pids))
        self.assertTrue(await self.adapter.room_left(self.adapter.session))
        for pid in pids:
            self.assert_reaped(pid)
        self.assertIsNone(self.asr.last_result)
        self.assertIsNone(self.mt.last_result)
        self.assertEqual(self.adapter.stats["buffered_bytes"], 0)
        self.assertEqual(self.adapter.stats["tracks"], 0)

    async def test_track_leave_kills_asr_process_then_other_participant_progresses(self):
        other = self.register("other")
        old = await self.submit(self.handle, 1, b"HANG_ASR")
        await eventually((self.directory / "asr-started").exists)
        old_pid = self.asr.stage.pid
        waiting = await self.submit(other, 1, b"survivor")
        self.assertTrue(self.adapter.unregister_track(self.handle))
        result = await asyncio.wait_for(waiting, 2)
        self.assertTrue(old.cancelled())
        self.assert_reaped(old_pid)
        self.assertEqual(result.participant_id, "other")
        self.assertEqual([item.source_text for item in self.results], ["survivor"])
        self.assertNotEqual(self.asr.stage.pid, old_pid)
        await asyncio.sleep(.65)
        self.assertFalse((self.directory / "asr-late").exists())

    async def test_reconnect_during_mt_kills_old_worker_and_blocks_old_callbacks(self):
        old_session = self.adapter.session
        old = await self.submit(self.handle, 1, b"HANG_MT")
        await eventually((self.directory / "mt-started").exists)
        old_pid = self.mt.stage.pid
        self.adapter.reconnect(old_session)
        replacement = self.register()
        self.assertFalse(self.adapter.unregister_track(self.handle))
        self.assertEqual(self.adapter.participant_left(old_session, "p"), 0)
        self.assertFalse(await self.adapter.room_left(old_session))
        with self.assertRaises(UnknownTrackError):
            await self.submit(self.handle, 2, b"late source")
        fresh = await self.submit(replacement, 1, b"fresh")
        result = await asyncio.wait_for(fresh, 2)
        self.assertTrue(old.cancelled())
        self.assert_reaped(old_pid)
        self.assertIs(result.track_handle, replacement)
        self.assertEqual([item.source_text for item in self.results], ["fresh"])
        await asyncio.sleep(.65)
        self.assertFalse((self.directory / "mt-late").exists())

    async def test_deadline_kills_real_asr_worker_without_mt_or_publication(self):
        # Warm the actual process protocol before timing the deliberately blocked call.
        await (await self.submit(self.handle, 1, b"warm"))
        self.results.clear()
        old_pid, mt_sequence = self.asr.stage.pid, self.mt.stage._sequence
        future = await self.submit(self.handle, 2, b"HANG_ASR",
                                   deadline=asyncio.get_running_loop().time() + .15)
        await eventually((self.directory / "asr-started").exists)
        with self.assertRaises(DeadlineError):
            await future
        await eventually(lambda: self.adapter.stats["active"] == 0)
        self.assert_reaped(old_pid)
        self.assertEqual(self.mt.stage._sequence, mt_sequence)
        self.assertEqual(self.results, [])
        self.assertEqual(self.adapter.stats["buffered_bytes"], 0)
        fresh = await self.submit(self.handle, 3, b"after deadline")
        self.assertEqual((await fresh).translated_text, "translated:after deadline")


if __name__ == "__main__":
    unittest.main()
