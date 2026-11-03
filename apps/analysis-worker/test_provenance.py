import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import worker


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ModelFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        directory = self.root / "whisper"
        directory.mkdir()
        self.files = []
        for name, data in {"model.bin": b"synthetic-model", "config.json": b"{}", "tokenizer.json": b"{}", "preprocessor_config.json": b"{}"}.items():
            (directory / name).write_bytes(data)
            self.files.append({"path": name, "sha256": digest(data), "bytes": len(data)})
        self.files.sort(key=lambda value: value["path"])
        gguf = b"GGUF" + b"\x03\x00\x00\x00" + b"\x00" * 24
        (self.root / "summary.gguf").write_bytes(gguf)
        self.manifest = {"schema": 1, "whisper": {"directory": "whisper", "files": self.files}, "summary": {"path": "summary.gguf", "sha256": digest(gguf), "bytes": len(gguf)}}
        self.write_manifest()
        self.environment = patch.dict(os.environ, {
            "ANALYSIS_MODEL_MANIFEST_PATH": str(self.root / "analysis-manifest.json"),
            "ANALYSIS_MODEL_MANIFEST_SHA256": self.manifest_hash,
            "WHISPER_MODEL_PATH": str(directory), "AI_SUMMARY_ENABLED": "false",
            "S3_ENDPOINT": "http://synthetic.invalid", "S3_BUCKET": "synthetic",
            "S3_ACCESS_KEY_ID": "synthetic", "S3_SECRET_ACCESS_KEY": "synthetic",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)
        readonly = patch("os.statvfs", return_value=SimpleNamespace(f_flag=os.ST_RDONLY))
        readonly.start()
        self.addCleanup(readonly.stop)
        worker._HEALTH_MODELS = None
        self.job = {"jobId": "b72869ed-f2eb-4013-8085-4793d5930dd6", "objectKey": "recordings/cb39e1bf-0bfd-4a4c-aea8-c2f77e57438d/b72869ed-f2eb-4013-8085-4793d5930dd6.mp4", "language": "ru", "summary": False}

    def write_manifest(self):
        raw = json.dumps(self.manifest, sort_keys=True).encode()
        (self.root / "analysis-manifest.json").write_bytes(raw)
        self.manifest_hash = digest(raw)

    def update_manifest(self):
        self.write_manifest()
        os.environ["ANALYSIS_MODEL_MANIFEST_SHA256"] = self.manifest_hash

    def fake_job(self):
        s3 = Mock()
        s3.head_object.return_value = {"ContentLength": 4}
        s3.get_object.return_value = {"Body": io.BytesIO(b"fake")}
        model = Mock()
        model.transcribe.return_value = ([SimpleNamespace(text="Synthetic transcript", start=0, end=1)], SimpleNamespace(language="en"))
        constructor = Mock(return_value=model)
        modules = {
            "boto3": SimpleNamespace(client=Mock(return_value=s3)),
            "botocore": SimpleNamespace(), "botocore.config": SimpleNamespace(Config=lambda **kwargs: kwargs),
            "faster_whisper": SimpleNamespace(WhisperModel=constructor),
        }
        return constructor, modules

    def process(self, modules):
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules), patch.object(worker.subprocess, "check_output", return_value=b'{"format":{"duration":"2"}}'):
            return worker.process_job(self.job, directory)


class RegressionTests(ModelFixture):
    def test_health_refuses_model_bin_without_matching_manifest(self):
        os.environ["ANALYSIS_MODEL_MANIFEST_SHA256"] = "0" * 64
        handler = SimpleNamespace(path="/health", reply=Mock())
        worker.Handler.do_GET(handler)
        self.assertEqual(handler.reply.call_args.args[0], 503)

    def test_invalid_manifest_refuses_processing_before_model_or_media_access(self):
        os.environ["ANALYSIS_MODEL_MANIFEST_SHA256"] = "0" * 64
        constructor, modules = self.fake_job()
        with self.assertRaises(RuntimeError):
            self.process(modules)
        constructor.assert_not_called()
        modules["boto3"].client.assert_not_called()


class ProvenanceTests(ModelFixture):
    def verify(self, **kwargs):
        from provenance import verify_models
        return verify_models(**kwargs)

    def test_actual_inventory_and_manifest_are_reported_after_loading(self):
        constructor, modules = self.fake_job()
        result = self.process(modules)
        bundle = digest(json.dumps(self.files, sort_keys=True, separators=(",", ":")).encode())
        self.assertEqual(result["model"], "faster-whisper-sha256-" + bundle)
        self.assertEqual(result["provenance"]["manifestSha256"], self.manifest_hash)
        self.assertEqual(result["provenance"]["whisper"]["files"], self.files)
        self.assertNotIn("summary", result["provenance"])
        self.assertNotIn("summaryModel", result)
        constructor.assert_called_once()
        self.assertEqual(constructor.call_args.args[0], str(self.root / "whisper"))
        self.assertTrue(constructor.call_args.kwargs["local_files_only"])

    def test_corrupt_missing_and_extra_whisper_files_fail_closed(self):
        model = self.root / "whisper" / "model.bin"
        model.write_bytes(b"different-bytes")
        with self.assertRaises(RuntimeError):
            self.verify()
        model.write_bytes(b"synthetic-model")
        extra = self.root / "whisper" / "unexpected.bin"
        extra.write_bytes(b"unlisted")
        with self.assertRaises(RuntimeError):
            self.verify()
        extra.unlink()
        (self.root / "whisper" / "tokenizer.json").unlink()
        with self.assertRaises(RuntimeError):
            self.verify()

    def test_manifest_requires_readonly_mount_and_explicit_expected_digest(self):
        with patch("os.statvfs", return_value=SimpleNamespace(f_flag=0)):
            with self.assertRaisesRegex(RuntimeError, "read-only"):
                self.verify()
        with patch.dict(os.environ, {"ANALYSIS_MODEL_MANIFEST_SHA256": ""}):
            with self.assertRaises(RuntimeError):
                self.verify()

    def test_traversal_symlink_duplicate_and_incomplete_inventory_are_rejected(self):
        for path in ("../escape", "/etc/passwd", "whisper//model.bin", "whisper/./model.bin"):
            self.manifest["summary"]["path"] = path
            self.update_manifest()
            with self.assertRaises(RuntimeError):
                self.verify()
        self.manifest["summary"]["path"] = "summary.gguf"
        self.update_manifest()
        (self.root / "summary.gguf").unlink()
        (self.root / "summary.gguf").symlink_to(self.root / "whisper" / "model.bin")
        with self.assertRaises(RuntimeError):
            self.verify()
        self.manifest["whisper"]["files"].append(self.files[0].copy())
        self.update_manifest()
        with self.assertRaises(RuntimeError):
            self.verify()

    def test_duplicate_json_fields_are_not_silently_overwritten(self):
        raw = (self.root / "analysis-manifest.json").read_bytes().replace(b'"schema": 1', b'"schema": 1, "schema": 1')
        (self.root / "analysis-manifest.json").write_bytes(raw)
        os.environ["ANALYSIS_MODEL_MANIFEST_SHA256"] = digest(raw)
        with self.assertRaisesRegex(RuntimeError, "Duplicate"):
            self.verify()

    def test_mutation_after_verification_is_detected_including_extra_file(self):
        models = self.verify()
        (self.root / "whisper" / "extra.bin").write_bytes(b"extra")
        with self.assertRaises(RuntimeError):
            models.assert_unchanged()
        (self.root / "whisper" / "extra.bin").unlink()
        models = self.verify()
        (self.root / "summary.gguf").write_bytes(b"GGUF" + b"x" * 28)
        with self.assertRaises(RuntimeError):
            models.assert_unchanged()

    def test_changed_model_during_loader_construction_never_returns_verified_result(self):
        constructor, modules = self.fake_job()
        original = constructor.return_value
        def load(*args, **kwargs):
            (self.root / "whisper" / "model.bin").write_bytes(b"changed-at-load")
            return original
        constructor.side_effect = load
        with self.assertRaises(RuntimeError):
            self.process(modules)
        original.transcribe.assert_not_called()

    def test_launcher_binds_measured_inode_and_alias_and_strips_model_overrides(self):
        from summary_launcher import prepare_launch
        models = self.verify(require_summary=True)
        with patch.dict(os.environ, {"LLAMA_ARG_MODEL": "/wrong.gguf", "LLAMA_ARG_ALIAS": "claim-only", "HF_TOKEN": "synthetic-not-exported"}):
            fd, args, env = prepare_launch(models, server="/synthetic/llama-server")
        try:
            self.assertEqual(args[args.index("--alias") + 1], "gguf-sha256-" + self.manifest["summary"]["sha256"])
            self.assertEqual(args[args.index("--model") + 1], "/proc/self/fd/" + str(fd))
            self.assertTrue(os.get_inheritable(fd))
            self.assertEqual(digest(os.read(fd, 1024)), self.manifest["summary"]["sha256"])
            self.assertFalse(any(key.startswith("LLAMA_ARG_") or key == "HF_TOKEN" for key in env))
            self.assertEqual(args.count("--model"), 1)
        finally:
            os.close(fd)

    def test_summary_service_must_be_loaded_and_report_exact_verified_alias(self):
        models = self.verify(require_summary=True)
        with patch.object(worker, "summary_json", side_effect=[{"status": "ok"}, {"data": [{"id": models.summary_identity}]}]):
            worker.verify_summary_service(models)
        for responses in ([{"status": "loading"}], [{"status": "ok"}, {"data": [{"id": "configured-name-only"}]}], [{"status": "ok"}, {"data": [{"id": models.summary_identity}, {"id": "other"}]}]):
            with patch.object(worker, "summary_json", side_effect=responses):
                with self.assertRaises(RuntimeError):
                    worker.verify_summary_service(models)

    def test_completion_binds_request_and_response_to_measured_gguf(self):
        models = self.verify(require_summary=True)
        with patch.object(worker, "summary_json", return_value={"model": models.summary_identity, "choices": [{"message": {"content": "Synthetic note"}}]}) as request:
            self.assertEqual(worker.complete_summary("Synthetic source", models), "Synthetic note")
            self.assertEqual(request.call_args.kwargs["data"]["model"], models.summary_identity)
        with patch.object(worker, "summary_json", return_value={"model": "wrong", "choices": [{"message": {"content": "not trusted"}}]}):
            with self.assertRaises(RuntimeError):
                worker.complete_summary("Synthetic source", models)

    def test_health_explicitly_reports_artifact_verification_without_claiming_whisper_loaded(self):
        handler = SimpleNamespace(path="/health", reply=Mock())
        worker.Handler.do_GET(handler)
        status, value = handler.reply.call_args.args
        self.assertEqual(status, 200)
        self.assertEqual(value["verification"], "files-verified")
        self.assertFalse(value["whisperLoaded"])
        self.assertEqual(value["provenance"]["manifestSha256"], self.manifest_hash)

    def test_summary_redirect_is_not_followed(self):
        handler = worker.NoSummaryRedirect()
        with self.assertRaises(RuntimeError):
            handler.redirect_request(None, None, 307, "redirect", {}, "http://external.invalid")


class DeploymentInputTests(ModelFixture):
    def script(self, name):
        import importlib.util
        path = Path(__file__).resolve().parents[2] / "scripts" / name
        spec = importlib.util.spec_from_file_location("fixture_script_" + name.replace("-", "_"), path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_image_gate_requires_official_digest_pins_without_claiming_registry_verification(self):
        validate = self.script("check-analysis-images.py").validate_images
        good = {"PYTHON_IMAGE": "python:3.12-slim@sha256:" + "a" * 64, "LLAMA_SERVER_IMAGE": "ghcr.io/ggml-org/llama.cpp:server@sha256:" + "b" * 64}
        validate(good, summary=True)
        for changed in ({"PYTHON_IMAGE": "python:latest"}, {"PYTHON_IMAGE": "attacker/python@sha256:" + "a" * 64}, {"LLAMA_SERVER_IMAGE": "ghcr.io/ggml-org/llama.cpp:server"}, {"LLAMA_SERVER_IMAGE": "ghcr.io/untrusted/llama.cpp:server@sha256:" + "b" * 64}):
            with self.assertRaises(ValueError):
                validate({**good, **changed}, summary=True)

    def test_offline_manifest_generator_measures_existing_files_and_roundtrips(self):
        create = self.script("create-analysis-manifest.py").create_manifest
        raw = create(self.root, "whisper", "summary.gguf")
        value = json.loads(raw)
        self.assertEqual(value["whisper"]["files"], self.files)
        self.assertEqual(value["summary"]["sha256"], self.manifest["summary"]["sha256"])
        (self.root / "analysis-manifest.json").write_bytes(raw)
        os.environ["ANALYSIS_MODEL_MANIFEST_SHA256"] = digest(raw)
        from provenance import verify_models
        models = verify_models(require_summary=True)
        self.assertEqual(models.manifest_sha256, digest(raw))
