"""Process-group identity regressions; no model or network activity."""
import asyncio
import pathlib
import signal
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from process_stage import ProcessStage

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
                # asyncio.Process.wait() consumes the leader before returning.
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

if __name__ == "__main__":
    unittest.main()
