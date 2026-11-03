#!/usr/bin/env python3
"""Ownership and failure-path tests. No real network commands are executed."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

loader = importlib.util.spec_from_file_location("transport_runtime", Path(__file__).with_name("manage-edge-transport.py"))
runtime = importlib.util.module_from_spec(loader)
loader.loader.exec_module(runtime)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.life = runtime.Lifecycle.__new__(runtime.Lifecycle)
        self.life.iface = "wg-meets"
        self.life.config_hash = "fixture-config"
        self.life.link_journal = Path(self.temp.name) / "link.json"
        self.life.guard_journal = Path(self.temp.name) / "guard.json"
        self.life.guard_journal.write_text("must-remain")
        self.journal = {"configHash": "fixture-config", "alias": "imon-meets-owned:test", "ifindex": 42}
        self.current = {"ifname": "wg-meets", "ifindex": 42, "ifalias": "imon-meets-owned:test", "linkinfo": {"info_kind": "wireguard"}}

    def exercise_stop(self, current, journal=None):
        if journal is not None:
            self.life.link_journal.write_text("fixture")
        with mock.patch.object(self.life, "link", return_value=current), mock.patch.object(runtime, "load_owned", return_value=journal), mock.patch.object(runtime, "run") as execute:
            self.life.link_stop()
        return execute

    def test_stop_owned_link_deletes_only_that_link_and_preserves_guard(self):
        execute = self.exercise_stop(self.current, self.journal)
        execute.assert_called_once_with([runtime.IP, "link", "delete", "dev", "wg-meets"])
        self.assertFalse(self.life.link_journal.exists())
        self.assertEqual(self.life.guard_journal.read_text(), "must-remain")

    def test_missing_link_removes_only_its_stale_journal(self):
        execute = self.exercise_stop(None, self.journal)
        execute.assert_not_called()
        self.assertFalse(self.life.link_journal.exists())
        self.assertEqual(self.life.guard_journal.read_text(), "must-remain")

    def test_foreign_or_replaced_link_never_deleted(self):
        cases = []
        for field, value in [("ifindex", 43), ("ifalias", "foreign"), ("linkinfo", {"info_kind": "dummy"})]:
            changed = copy.deepcopy(self.current); changed[field] = value
            cases.append((changed, self.journal))
        cases.extend([(self.current, None), (self.current, {**self.journal, "ifindex": None}), (self.current, {**self.journal, "configHash": "different"})])
        for current, journal in cases:
            with self.subTest(current=current, journal=journal):
                self.life.link_journal.unlink(missing_ok=True)
                if journal is not None: self.life.link_journal.write_text("fixture")
                with mock.patch.object(self.life, "link", return_value=current), mock.patch.object(runtime, "load_owned", return_value=journal), mock.patch.object(runtime, "run") as execute:
                    with self.assertRaises(runtime.Error): self.life.link_stop()
                execute.assert_not_called()
                self.assertEqual(self.life.guard_journal.read_text(), "must-remain")

    def test_incomplete_guard_journal_does_not_mutate_or_adopt(self):
        with mock.patch.object(runtime, "load_owned", return_value={"phase": "installing", "configHash": self.life.config_hash}), mock.patch.object(runtime, "run") as execute:
            with self.assertRaisesRegex(runtime.Error, "GUARD_NOT_OWNED_OR_INCOMPLETE"):
                self.life.guard_start()
        execute.assert_not_called()

    def test_failed_link_creation_never_deletes_conflicting_interface(self):
        self.life.base = Path(self.temp.name)
        self.life.local = {"publicKey": "fixture-public"}
        (self.life.base / "private.key").write_bytes(b"fixture-only")
        success = mock.Mock(returncode=0, stdout=b"fixture-public\n")
        with mock.patch.object(self.life, "verify_guard"), mock.patch.object(self.life, "link", side_effect=[None, self.current]), mock.patch.object(runtime, "secure_path"), mock.patch.object(runtime.subprocess, "run", return_value=success), mock.patch.object(runtime, "run", side_effect=runtime.Error("SCOPED_COMMAND_FAILED")) as execute:
            with self.assertRaisesRegex(runtime.Error, "SCOPED_COMMAND_FAILED"):
                self.life.link_start()
        execute.assert_called_once_with([runtime.IP, "link", "add", "dev", "wg-meets", "type", "wireguard"])
        self.assertEqual(self.life.guard_journal.read_text(), "must-remain")


if __name__ == "__main__":
    unittest.main()
