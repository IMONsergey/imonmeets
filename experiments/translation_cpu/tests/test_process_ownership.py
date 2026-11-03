"""Real-child and deterministic ownership regressions; no model or network."""
import asyncio
import os
import pathlib
import select
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from process_stage import ProcessStage, StageCleanupError
from owned_process import OwnedProcess, OwnedSpawnError, ProcessOwnershipError, spawn_owned_process

ECHO = "import sys,json\nfor line in sys.stdin:\n r=json.loads(line);print(json.dumps({'id':r['id'],'ok':True,'result':r['payload']}),flush=True)"
HANG = "import sys,time,signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nsys.stdin.readline()\ntime.sleep(60)"
CHILD = "import os,pathlib,signal,sys,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(60)"
PARENT = """import pathlib,subprocess,sys,time
sys.stdin.readline()
subprocess.Popen([sys.executable,'-u','-c',sys.argv[1],sys.argv[2]],start_new_session=sys.argv[3]=='escape')
while not pathlib.Path(sys.argv[2]).exists():time.sleep(.001)
if sys.argv[3]=='escape':time.sleep(60)
"""

async def eventually(predicate, timeout=3):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.002)

async def cleanup_fixture_child(pidfd):
    # Only the test's captured kernel identity is signaled, never its numeric PID.
    try:
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await eventually(lambda: bool(select.select([pidfd], [], [], 0)[0]))
    os.close(pidfd)

class ProcessOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_group_signal_may_follow_leader_reap(self):
        events = []
        class Pipe:
            def close(self):
                pass
            async def drain_eof(self):
                pass
        class Process:
            pid = 123456789
            reaped = False
            unproven_descendants = False
            stdin = stdout = Pipe()
            async def wait(self):
                # Historical asyncio.Process.wait() consumed the leader.
                self.reaped = True
                events.append("reap")
            async def wait_exited(self):
                events.append("observe_exit_without_reap")
            def signal_group(self, sig):
                record_signal(self.pid, sig)
            def reap(self):
                self.reaped = True
                events.append("reap")
            def close_pipes(self):
                pass
        process = Process()
        def record_signal(pid, sig):
            events.append((sig.name, process.reaped))
        stage = ProcessStage([sys.executable])
        stage._process = process
        with patch("process_stage.os.killpg", record_signal):
            await stage._stop()
        self.assertEqual([item for item in events if isinstance(item, tuple)],
                         [("SIGTERM", False), ("SIGKILL", False)])
        self.assertEqual(events[-1], "reap")

    async def test_exited_leader_is_retained_until_term_ignoring_descendant_is_killed(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / "child-pid"
            stage = ProcessStage([sys.executable, "-u", "-c", PARENT, CHILD, str(marker), "same-group"],
                                 terminate_grace_seconds=.02, reap_timeout_seconds=.3)
            call = asyncio.create_task(stage.request({}))
            child_fd = None
            try:
                await eventually(marker.exists)
                child_fd = os.pidfd_open(int(marker.read_text()))
                process = stage._process
                leader = process.pid
                await asyncio.wait_for(process.wait_exited(), 1)
                self.assertFalse(process.reaped)
                self.assertIsNone(process._popen.returncode)
                self.assertEqual(pathlib.Path(f"/proc/{leader}/stat").read_text().split(") ", 1)[1].split()[0], "Z")
                observed = []
                killpg = os.killpg
                def record_and_signal(pgid, sig):
                    # Successful waitid(WNOWAIT) proves the unreaped direct child.
                    status = os.waitid(os.P_PIDFD, process._pidfd, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                    self.assertIsNotNone(status)
                    self.assertFalse(process.reaped)
                    self.assertEqual(pgid, leader)
                    observed.append(sig)
                    killpg(pgid, sig)
                with patch("owned_process.os.killpg", record_and_signal):
                    call.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await call
                self.assertEqual(observed, [signal.SIGTERM, signal.SIGKILL])
                await eventually(lambda: bool(select.select([child_fd], [], [], 0)[0]))
                self.assertTrue(process.reaped)
                self.assertTrue(process.stdin.stream.closed)
                self.assertTrue(process.stdout.stream.closed)
                self.assertIsNone(process._pidfd)
                self.assertIsNone(stage.pid)
                self.assertEqual(stage.stats["pending_bytes"], 0)
            finally:
                await stage.close()
                await asyncio.gather(call, return_exceptions=True)
                if child_fd is not None:
                    await cleanup_fixture_child(child_fd)

    async def test_after_reap_neither_term_nor_kill_can_reuse_the_numeric_group(self):
        stage = ProcessStage([sys.executable, "-u", "-c", ECHO])
        await stage.request({"warm": True})
        process = stage._process
        await stage.close()
        self.assertTrue(process.reaped)
        with patch("owned_process.os.killpg") as killpg:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                with self.assertRaises(ProcessOwnershipError):
                    process.signal_group(sig)
            await stage.close()
            killpg.assert_not_called()

    async def test_external_reap_echild_closes_admission_and_descriptors_without_signals(self):
        stage = ProcessStage([sys.executable, "-u", "-c", ECHO])
        await stage.request({"warm": True})
        process = stage._process
        # Deliberately violate the sole-reaper contract inside this owned fixture.
        # Cleanup targets the captured kernel identity, then the test consumes it.
        signal.pidfd_send_signal(process._pidfd, signal.SIGKILL)
        await asyncio.wait_for(process.wait_exited(), 1)
        process._popen.wait(timeout=0)
        with patch("owned_process.os.killpg") as killpg:
            with self.assertRaises(StageCleanupError):
                await stage._stop()
            with self.assertRaises(StageCleanupError):
                await stage.close()
            killpg.assert_not_called()
        self.assertIs(stage._process, process)
        self.assertTrue(process.ownership_lost)
        self.assertTrue(process.stdin.stream.closed)
        self.assertTrue(process.stdout.stream.closed)
        self.assertIsNone(process._pidfd)
        self.assertTrue(stage.stats["closed"])
        self.assertTrue(stage.stats["quarantined"])
        with self.assertRaises(RuntimeError):
            await stage.request({"must_not_spawn": True})

    async def test_escaped_descendant_with_pipe_fails_bounded_and_fixture_cleans_by_pidfd(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = pathlib.Path(directory) / "escaped-pid"
            stage = ProcessStage([sys.executable, "-u", "-c", PARENT, CHILD, str(marker), "escape"],
                                 terminate_grace_seconds=.02, reap_timeout_seconds=.06)
            call = asyncio.create_task(stage.request({"native": "retained"}))
            child_fd = None
            try:
                await eventually(marker.exists)
                child_fd = os.pidfd_open(int(marker.read_text()))
                process, reserved = stage._process, stage.stats["pending_bytes"]
                started = asyncio.get_running_loop().time()
                call.cancel()
                with self.assertRaises(StageCleanupError):
                    await call
                self.assertLess(asyncio.get_running_loop().time() - started, .6)
                self.assertTrue(process.reaped)
                self.assertTrue(process.unproven_descendants)
                self.assertTrue(process.stdin.stream.closed)
                self.assertTrue(process.stdout.stream.closed)
                self.assertIsNone(process._pidfd)
                self.assertEqual(stage.stats["pending"], 1)
                self.assertEqual(stage.stats["pending_bytes"], reserved)
                self.assertTrue(stage.stats["closed"])
                self.assertTrue(stage.stats["quarantined"])
                signal.pidfd_send_signal(child_fd, 0)  # Still alive, intentionally outside group contract.
                self.assertFalse(select.select([child_fd], [], [], 0)[0])
                with patch("owned_process.os.killpg") as killpg:
                    with self.assertRaises(StageCleanupError):
                        await stage.close()
                    with self.assertRaises(RuntimeError):
                        await stage.request({"must_not_replace": True})
                    killpg.assert_not_called()
            finally:
                if child_fd is not None:
                    await cleanup_fixture_child(child_fd)
                await asyncio.gather(call, return_exceptions=True)
                try:
                    await stage.close()
                except StageCleanupError:
                    pass
            # External cleanup does not retroactively assert arbitrary-tree ownership.
            self.assertTrue(stage.stats["quarantined"])

    async def test_synchronous_spawn_throw_returns_error_and_releases_reservation(self):
        stage = ProcessStage(["/definitely/not/an/executable/imonmeets-worker"])
        with patch("owned_process.os.killpg") as killpg:
            with self.assertRaises(FileNotFoundError):
                await stage.request({"test": True})
            killpg.assert_not_called()
        self.assertIsNone(stage.pid)
        self.assertEqual(stage.stats["pending"], 0)
        self.assertEqual(stage.stats["pending_bytes"], 0)
        await stage.close()

    async def test_pidfd_setup_failure_retains_spawned_child_for_safe_cleanup(self):
        stage = ProcessStage([sys.executable, "-u", "-c", HANG], terminate_grace_seconds=.02)
        with patch("owned_process.os.pidfd_open", side_effect=OSError("injected setup failure")):
            with self.assertRaises(OwnedSpawnError) as caught:
                await stage.request({"test": True})
        process = caught.exception.process
        self.assertTrue(process.reaped)
        self.assertTrue(process._popen.stdin.closed)
        self.assertTrue(process._popen.stdout.closed)
        self.assertIsNone(stage.pid)
        self.assertEqual(stage.stats["pending_bytes"], 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(process.pid, 0)
        await stage.close()

    async def test_non_linux_and_external_sigchld_handler_fail_before_spawn(self):
        for kind, value in (("platform", "darwin"), ("handler", signal.SIG_IGN), ("handler", lambda *_: None)):
            target = "owned_process.sys.platform" if kind == "platform" else "owned_process.signal.getsignal"
            kwargs = {"new": value} if kind == "platform" else {"return_value": value}
            with self.subTest(kind=kind), patch(target, **kwargs), patch("owned_process.subprocess.Popen") as popen:
                with self.assertRaises(ProcessOwnershipError):
                    await spawn_owned_process([sys.executable], environment={}, max_output_bytes=1024)
                popen.assert_not_called()

if __name__ == "__main__":
    unittest.main()
