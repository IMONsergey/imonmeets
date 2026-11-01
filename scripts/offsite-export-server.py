#!/usr/bin/env python3
"""Read-only encrypted backup and sanitized health export behind the existing TLS proxy."""
import argparse
import datetime
import hmac
import http.server
import importlib.util
import json
import os
import pathlib
import re
import stat

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
_recording_spec = importlib.util.spec_from_file_location(
    "recording_backup_common", pathlib.Path(__file__).with_name("recording-backup.py"))
recording_backup = importlib.util.module_from_spec(_recording_spec)
_recording_spec.loader.exec_module(recording_backup)


def recording_manifest(project):
    result = recording_backup.validate_manifest(recording_backup.read_json(project / "backups/recordings/manifest.json"))
    result["objects"] = [obj for obj in result["objects"]
                         if recording_backup.timestamp(obj["expiresAt"]) > recording_backup.utcnow()]
    return result


def regular_file(path):
    """Do not follow a substituted symlink, including between stat and open."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    handle = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        handle.close()
        raise ValueError("Not a regular file")
    return handle


def latest_archive(project):
    with regular_file(project / "backups/latest.json") as source:
        manifest = json.loads(source.read(65537))
    name = manifest.get("file", "")
    if not re.fullmatch(r"imonmeets-\d{8}T\d{6}Z\.dump", name):
        raise ValueError("Invalid backup manifest")
    archive = regular_file(project / "backups" / (name + ".enc"))
    size = os.fstat(archive.fileno()).st_size
    if not 100 <= size <= MAX_ARCHIVE_BYTES:
        archive.close()
        raise ValueError("Invalid encrypted archive size")
    return archive, name + ".enc", size


def sanitized_health(project, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        with regular_file(project / "ops-state/health.json") as source:
            health = json.loads(source.read(65537))
        checked = datetime.datetime.fromisoformat(health["checkedAt"].replace("Z", "+00:00"))
        age = (now - checked).total_seconds()
        checks = {key: {"ok": value.get("ok") is True}
                  for key, value in health.get("checks", {}).items()
                  if key in {"api", "mediaSignaling", "backup", "disk", "recordingStorage"}}
        ok = health.get("ok") is True and bool(checks) and 0 <= age <= 600
        return {"ok": ok, "checkedAt": health["checkedAt"],
                "ageSeconds": round(age), "checks": checks}
    except Exception:
        return {"ok": False, "reason": "Operational status unavailable"}


def make_handler(project, token):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "IMON"
        sys_version = ""

        def log_message(self, *args):
            # Do not log request targets, headers, tokens or user IP addresses.
            pass

        def send_headers(self, status, content_type, length):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()

        def json_response(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_headers(status, "application/json", len(data))
            self.wfile.write(data)

        def do_GET(self):
            supplied = self.headers.get("Authorization", "")
            if not hmac.compare_digest(supplied.encode(), ("Bearer " + token).encode()):
                self.json_response(401, {"error": "unauthorized"})
                return
            if self.path == "/_ops/health":
                # Return 200 even for a failed health check so the monitor can
                # distinguish an application incident from a transport failure.
                self.json_response(200, sanitized_health(project))
            elif self.path == "/_ops/backup":
                try:
                    source, name, size = latest_archive(project)
                except Exception:
                    self.json_response(503, {"error": "backup_unavailable"})
                    return
                with source:
                    self.send_headers(200, "application/octet-stream", size)
                    for block in iter(lambda: source.read(128 * 1024), b""):
                        self.wfile.write(block)
            elif self.path == "/_ops/recordings":
                try:
                    self.json_response(200, recording_manifest(project))
                except Exception:
                    self.json_response(503, {"error": "recording_backup_unavailable"})
            elif re.fullmatch(r"/_ops/recordings/[0-9a-f]{64}\.enc", self.path):
                try:
                    manifest = recording_manifest(project)
                    name = self.path.rsplit("/", 1)[1]
                    item = next((obj for obj in manifest["objects"] if obj["cipherFile"] == name), None)
                    if item is None:
                        self.json_response(404, {"error": "not_found"})
                        return
                    source = regular_file(project / "backups/recordings" / name)
                    if os.fstat(source.fileno()).st_size != item["cipherBytes"]:
                        source.close()
                        raise ValueError("Encrypted recording size mismatch")
                except Exception:
                    self.json_response(503, {"error": "recording_backup_unavailable"})
                    return
                with source:
                    self.send_headers(200, "application/octet-stream", item["cipherBytes"])
                    for block in iter(lambda: source.read(128 * 1024), b""):
                        self.wfile.write(block)
            else:
                self.json_response(404, {"error": "not_found"})

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=pathlib.Path, required=True)
    parser.add_argument("--token-file", type=pathlib.Path, required=True)
    parser.add_argument("--port", type=int, default=3542)
    args = parser.parse_args()
    token = args.token_file.read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
        raise SystemExit("Invalid export token")
    handler = make_handler(args.project.resolve(), token)
    class BoundedServer(http.server.HTTPServer):
        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(30)
            return connection, address
    server = BoundedServer(("127.0.0.1", args.port), handler)
    server.timeout = 10
    while True:
        server.handle_request()


if __name__ == "__main__":
    main()
