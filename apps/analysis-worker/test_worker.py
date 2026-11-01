import importlib.util
import socket
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ValidationTests(unittest.TestCase):
    def test_job_accepts_only_scoped_recordings_and_bounded_options(self):
        job = {"jobId": "b72869ed-f2eb-4013-8085-4793d5930dd6", "objectKey": "recordings/cb39e1bf-0bfd-4a4c-aea8-c2f77e57438d/b72869ed-f2eb-4013-8085-4793d5930dd6.mp4", "language": "ru", "summary": True}
        self.assertEqual(worker.validate_job(job), job)
        for changed in [{"objectKey": "../../secret"}, {"objectKey": "https://attacker.example/file.mp4"}, {"language": "shell"}, {"summary": "true"}, {"jobId": "anything"}, {"extra": "ignored"}]:
            with self.assertRaises(ValueError):
                worker.validate_job({**job, **changed})

    def test_summary_chunking_never_discards_middle_or_tail(self):
        text = "a" * 9300 + "\nmiddle\n" + "b" * 12000 + "\ntail"
        parts = worker.chunks(text)
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(len(part) <= 6500 for part in parts))
        self.assertTrue(parts[-1].endswith("tail"))

    def test_private_http_connection_detects_close_and_unexpected_input(self):
        server, client = socket.socketpair()
        try:
            self.assertFalse(worker.client_disconnected(server))
            client.sendall(b"unexpected extra request")
            self.assertTrue(worker.client_disconnected(server))
            server.recv(100)
            self.assertFalse(worker.client_disconnected(server))
            client.close()
            self.assertTrue(worker.client_disconnected(server))
        finally:
            server.close()
            client.close()

    def test_disconnected_request_stops_waiting_before_reading_results(self):
        process, pipe = Mock(), Mock()
        with patch.object(worker, "client_disconnected", return_value=True):
            with self.assertRaises(worker.ClientDisconnected):
                worker.wait_for_job(process, pipe, object())
        pipe.poll.assert_not_called()
        pipe.recv_bytes.assert_not_called()

    def test_job_timeout_is_bounded_without_waiting_for_real_time(self):
        process, pipe = Mock(), Mock()
        process.is_alive.return_value = True
        pipe.poll.return_value = False
        with patch.object(worker, "client_disconnected", return_value=False), patch.object(
            worker.time, "monotonic", side_effect=[0, 0, 2]
        ):
            with self.assertRaises(TimeoutError):
                worker.wait_for_job(process, pipe, object(), timeout=1)
        pipe.poll.assert_called_once_with(0.25)

    def test_cancellation_terminates_child_before_removing_private_directory(self):
        context, process, parent, child = Mock(), Mock(), Mock(), Mock()
        context.Pipe.return_value = (parent, child)
        directories = []

        def create_process(**kwargs):
            directory = Path(kwargs["args"][1])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            (directory / "recording.mp4").write_bytes(b"synthetic private media")
            directories.append(directory)
            return process

        def stop(stopped):
            self.assertIs(stopped, process)
            self.assertTrue((directories[0] / "recording.mp4").is_file())

        context.Process.side_effect = create_process
        with patch.object(worker.multiprocessing, "get_context", return_value=context), patch.object(
            worker, "wait_for_job", side_effect=worker.ClientDisconnected
        ), patch.object(worker, "stop_process", side_effect=stop) as stopped:
            with self.assertRaises(worker.ClientDisconnected):
                worker.execute_job({}, object())
        stopped.assert_called_once_with(process)
        self.assertFalse(directories[0].exists())
        parent.close.assert_called_once()
        self.assertGreaterEqual(child.close.call_count, 1)

    def test_cancel_kills_decoder_group_before_finishing_child_cleanup(self):
        process = Mock(pid=12345)
        process.is_alive.side_effect = [True, False]
        with patch.object(worker.os, "killpg") as kill:
            worker.stop_process(process)
        self.assertEqual(
            [call.args for call in kill.call_args_list],
            [(12345, worker.signal.SIGTERM), (12345, worker.signal.SIGKILL)],
        )
        process.join.assert_called_once_with(timeout=5)
        process.terminate.assert_not_called()

    def test_failed_child_start_has_no_pid_and_does_not_touch_another_process(self):
        process = Mock(pid=None)
        with patch.object(worker.os, "killpg") as kill:
            worker.stop_process(process)
        kill.assert_not_called()
        process.join.assert_not_called()


if __name__ == "__main__":
    unittest.main()
