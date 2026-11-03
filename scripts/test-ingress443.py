"""Isolated real nginx + pinned HAProxy acceptance, no production listeners.

Run with Node 24 on PATH, nginx and passwordless Docker access. All sockets bind
loopback high ports. Synthetic services verify routing, not real TURN/media.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3"
DOCKER = ["sudo", "-n", "docker"]
PROXY_SECRET = "synthetic-proxy-secret-for-isolated-test-20261103"
SIGNAL_SECRET = "synthetic-signaling-secret-isolated-test-20261103"
SEEN = []
LOCK = threading.Lock()


def reserve_ports(number):
    held = []
    try:
        for _ in range(number):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            held.append(sock)
        return [sock.getsockname()[1] for sock in held]
    finally:
        for sock in held:
            sock.close()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        headers = {key.lower(): value for key, value in self.headers.items()}
        kind = self.server.kind
        with LOCK:
            SEEN.append({"kind": kind, "path": self.path, "headers": headers, "method": self.command})
        if kind == "api" and self.path.startswith("/api/internal/"):
            token = headers.get("x-imon-livekit-token", "")
            bearer = headers.get("authorization", "").removeprefix("Bearer ")
            status = 403
            if (self.path == "/api/internal/livekit/authorize" and
                headers.get("x-imon-proxy-secret") == PROXY_SECRET and
                headers.get("x-imon-livekit-auth") == SIGNAL_SECRET):
                status = 401 if token and bearer and token != bearer else {
                    "good": 204, "banned": 403, "expired": 401, "unavailable": 503
                }.get(token or bearer, 401)
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if kind == "rtc" and headers.get("upgrade", "").lower() == "websocket":
            accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.close_connection = True
            return
        body = json.dumps({"kind": kind, "path": self.path, "headers": headers, "method": self.command}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_HEAD = do_GET
    do_POST = do_GET


def http_request(port, host, target, method="GET", headers=None, tls=True):
    raw = socket.socket()
    raw.settimeout(8)
    # Distinct source IP proves PROXY v2 is preserved through HAProxy/nginx.
    raw.bind(("127.0.0.2", 0))
    raw.connect(("127.0.0.1", port))
    if tls:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        sock = context.wrap_socket(raw, server_hostname=host)
    else:
        sock = raw
    try:
        lines = [f"{method} {target} HTTP/1.1", f"Host: {host}", "Connection: close"]
        for key, value in (headers or {}).items():
            if key.lower() == "connection":
                lines = [line for line in lines if not line.lower().startswith("connection:")]
            lines.append(f"{key}: {value}")
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        response = http.client.HTTPResponse(sock, method=method)
        response.begin()
        body = response.read() if response.status != 101 else b""
        return response.status, dict(response.getheaders()), body
    finally:
        sock.close()


def main():
    assert shutil.which("node") and shutil.which("openssl")
    subprocess.run(["node", "--version"], check=True)
    ports = reserve_ports(7)
    public, plain, nginx_port, api_port, rtc_port, s3_port, turn_port = ports
    name = f"imon-ingress-acceptance-{os.getpid()}"
    servers, processes = [], []
    checks = []
    def passed(name):
        checks.append(name)
        print("PASS", name, flush=True)
    with tempfile.TemporaryDirectory(prefix="imon-ingress-acceptance-") as directory:
        folder = Path(directory)
        try:
            cert, key = folder / "cert.pem", folder / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.example.test", "-addext", "subjectAltName=DNS:app.example.test,DNS:rtc.example.test,DNS:turn.example.test,DNS:files.example.test", "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
            env = {"INGRESS_PUBLIC_IP": "192.0.2.20", "VPN_PUBLIC_IP": "192.0.2.21", "APP_URL": "https://app.example.test", "LIVEKIT_URL": "wss://rtc.example.test", "TURN_PUBLIC_HOST": "turn.example.test", "RECORDING_ENABLED": "true", "S3_BUCKET": "imon-recordings", "S3_PUBLIC_ENDPOINT": "https://files.example.test", "LIVEKIT_SIGNALING_AUTH_ENABLED": "true", "ORIGIN_PROXY_SECRET": PROXY_SECRET, "LIVEKIT_SIGNALING_AUTH_SECRET": SIGNAL_SECRET}
            layout = {"bind": "127.0.0.1", "publicPort": public, "httpPort": plain, "nginxPort": nginx_port, "apiPort": api_port, "rtcPort": rtc_port, "s3Port": s3_port, "turnPort": turn_port, "cert": str(cert), "key": str(key), "trust": str(folder / "trust.conf"), "signal": str(folder / "signal.conf"), "acme": str(folder / "acme")}
            code = "import {ingressConfig,renderIngress} from './scripts/prepare-ingress443.mjs'; const x=JSON.parse(process.argv[1]); console.log(JSON.stringify(renderIngress(ingressConfig(x.env),x.layout)));"
            rendered = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", code, json.dumps({"env": env, "layout": layout})], cwd=ROOT))
            for key_name, file_name in [("nginx", "routes.conf"), ("haproxy", "haproxy.cfg"), ("trust", "trust.conf"), ("signal", "signal.conf")]:
                (folder / file_name).write_text(rendered[key_name])
            # This synthetic routing-only fixture is mounted into the non-root
            # HAProxy container. Make just that file readable across its UID;
            # the host directory stays private and production output stays0600.
            (folder / "haproxy.cfg").chmod(0o644)
            (folder / "nginx.conf").write_text(f"worker_processes 1;\npid {folder}/nginx.pid;\nerror_log {folder}/nginx.error.log warn;\nevents {{ worker_connections 128; }}\nhttp {{ access_log off; client_body_temp_path {folder}/body; proxy_temp_path {folder}/proxy; include {folder}/routes.conf; }}\n")
            for kind, port in [("api", api_port), ("rtc", rtc_port), ("s3", s3_port), ("turn", turn_port)]:
                server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
                server.kind = kind
                server.daemon_threads = True
                if kind == "turn":
                    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                    context.load_cert_chain(cert, key)
                    server.socket = context.wrap_socket(server.socket, server_side=True)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                servers.append(server)
            subprocess.run(["/usr/sbin/nginx", "-t", "-p", str(folder), "-c", str(folder / "nginx.conf")], check=True, capture_output=True)
            subprocess.run(DOCKER + ["run", "--rm", "--network", "none", "--cpus", "0.5", "--memory", "128m", "-v", f"{folder}/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro", IMAGE, "haproxy", "-c", "-f", "/usr/local/etc/haproxy/haproxy.cfg"], check=True, capture_output=True)
            passed("actual nginx and pinned HAProxy syntax")
            log = (folder / "nginx.stdout.log").open("w")
            processes.append(subprocess.Popen(["/usr/sbin/nginx", "-p", str(folder), "-c", str(folder / "nginx.conf"), "-g", "daemon off;"], stdout=log, stderr=log))
            subprocess.run(DOCKER + ["run", "-d", "--rm", "--name", name, "--label", "imonmeets.scope=disposable-ingress-acceptance", "--network", "host", "--cpus", "0.5", "--memory", "128m", "--pids-limit", "32", "--read-only", "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID", "--security-opt", "no-new-privileges", "-v", f"{folder}/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro", IMAGE, "haproxy", "-W", "-db", "-f", "/usr/local/etc/haproxy/haproxy.cfg"], check=True, capture_output=True)
            deadline = time.monotonic() + 10
            while True:
                try:
                    status, _, body = http_request(public, "app.example.test", "/")
                    assert status == 200
                    break
                except (OSError, AssertionError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            passed("TLS web homepage on SNI route")
            forged = {"X-Forwarded-For": "198.51.100.7, 10.0.0.2", "X-Real-IP": "198.51.100.8", "Forwarded": "for=198.51.100.9", "X-IMON-Proxy-Secret": "forged", "X-IMON-LiveKit-Auth": "forged", "X-IMON-LiveKit-Token": "good"}
            status, _, body = http_request(public, "app.example.test", "/api/session", headers=forged)
            received = json.loads(body)["headers"]
            assert status == 200 and received["x-forwarded-for"] == "127.0.0.2" and received["x-real-ip"] == "127.0.0.2"
            assert received["x-imon-proxy-secret"] == PROXY_SECRET and "forwarded" not in received
            assert "x-imon-livekit-auth" not in received and "x-imon-livekit-token" not in received
            passed("PROXY v2 client address and forged trusted header replacement")
            assert http_request(public, "app.example.test", "/api/internal/livekit/authorize?access_token=good", headers=forged)[0] == 404
            passed("public internal API path blocked")
            for route in ["/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate"]:
                assert http_request(public, "rtc.example.test", route + "?access_token=good&join_request=encoded")[0] == 200
                with LOCK:
                    admission = [row for row in SEEN if row["path"] == "/api/internal/livekit/authorize"][-1]
                assert admission["headers"]["x-imon-livekit-token"] == "good"
                assert admission["headers"]["x-forwarded-for"] == "127.0.0.2"
                assert "cookie" not in admission["headers"]
                for token, expected in [("banned", 403), ("expired", 401), ("unavailable", 503), ("", 401)]:
                    with LOCK:
                        before = len([row for row in SEEN if row["kind"] == "rtc"])
                    status = http_request(public, "rtc.example.test", route + "?access_token=" + token, headers=forged)[0]
                    assert status == expected, (route, token, status)
                    with LOCK:
                        assert before == len([row for row in SEEN if row["kind"] == "rtc"])
                passed(route + " accepts authorized and fails closed before upstream on revoke/expiry/unavailability")
            assert http_request(public, "rtc.example.test", "/rtc/v1?access_token=good", headers={"Authorization": "Bearer banned"})[0] == 401
            assert http_request(public, "rtc.example.test", "/rtc/v1", headers={"Authorization": "Bearer good"})[0] == 200
            assert http_request(public, "rtc.example.test", "/rtc/v1?access_token=good", method="POST")[0] == 403
            passed("bearer supported, conflicting credentials and methods rejected")
            status, headers, _ = http_request(public, "rtc.example.test", "/rtc/v1?access_token=good", headers={"Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13"})
            assert status == 101 and headers.get("Sec-WebSocket-Accept") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
            passed("authorized WebSocket upgrade survives gate")
            for target in ["/_imon_livekit_admission", "/twirp/livekit.RoomService/ListRooms", "/rtc/extra", "/"]:
                assert http_request(public, "rtc.example.test", target)[0] == 404
            passed("signaling management and internal admission not public")
            signed = "/imon-recordings/recordings/example.mp4?X-Amz-Signature=synthetic%2Bsignature&X-Amz-Credential=example%2Fdate"
            status, _, body = http_request(public, "files.example.test", signed)
            obj = json.loads(body)
            assert status == 200 and obj["path"] == signed and obj["headers"]["host"] == "files.example.test"
            assert http_request(public, "files.example.test", signed, method="HEAD")[0] == 200
            assert http_request(public, "files.example.test", signed, method="POST")[0] == 403
            assert http_request(public, "files.example.test", "/imon-recordings/")[0] == 404
            passed("recording signature inputs preserved, writes and bucket list blocked")
            assert json.loads(http_request(public, "turn.example.test", "/")[2])["kind"] == "turn"
            passed("TURN SNI receives intact TLS stream without PROXY prefix (routing only)")
            status, headers, _ = http_request(plain, "app.example.test", "/join?x=1", tls=False)
            assert status == 308 and headers["Location"] == "https://app.example.test/join?x=1"
            challenge = folder / "acme/.well-known/acme-challenge/test"
            challenge.parent.mkdir(parents=True)
            challenge.write_text("challenge")
            assert http_request(plain, "app.example.test", "/.well-known/acme-challenge/test", tls=False)[2] == b"challenge"
            passed("HTTP canonical redirect and ACME webroot")
            try:
                http_request(public, "unknown.example.test", "/")
            except (OSError, http.client.HTTPException):
                pass
            else:
                raise AssertionError("Unknown SNI was accepted")
            passed("unknown SNI rejected")
            for changes in [{"INGRESS_PUBLIC_IP": env["VPN_PUBLIC_IP"]}, {"APP_URL": "https://app.example.test:8443"}, {"LIVEKIT_URL": "wss://rtc.example.test:8443"}, {"TURN_PUBLIC_HOST": "rtc.example.test"}, {"LIVEKIT_SIGNALING_AUTH_ENABLED": "false"}, {"TURN_PUBLIC_HOST": "turn.example.test;bad"}]:
                bad = {**env, **changes}
                result = subprocess.run(["node", "--input-type=module", "-e", code, json.dumps({"env": bad, "layout": layout})], cwd=ROOT, capture_output=True)
                assert result.returncode != 0
            passed("unsafe candidate inputs refused")
            candidate = folder / "candidate"
            generation_env = {**os.environ, **env, "INGRESS_OUTPUT_DIR": str(candidate)}
            result = subprocess.run(["node", "scripts/prepare-ingress443.mjs"], cwd=ROOT, env=generation_env, capture_output=True, text=True, check=True)
            assert candidate.stat().st_mode & 0o777 == 0o700
            assert all(p.stat().st_mode & 0o777 == 0o600 for p in candidate.iterdir())
            assert PROXY_SECRET not in result.stdout and SIGNAL_SECRET not in result.stdout
            plan = json.loads((candidate / "plan.json").read_text())
            assert plan["applied"] is False and plan["externalAcceptance"] is False
            assert PROXY_SECRET not in (candidate / "plan.json").read_text()
            original = (candidate / "haproxy.cfg").read_bytes()
            assert subprocess.run(["node", "scripts/prepare-ingress443.mjs"], cwd=ROOT, env=generation_env, capture_output=True).returncode != 0
            assert (candidate / "haproxy.cfg").read_bytes() == original
            passed("actual candidate generation is private and refuses overwrite")
            media = folder / "livekit.public.yaml"
            media.write_text("port: 7880\nrtc:\n  udp_port: 7882\n")
            (folder / "fullchain.pem").write_bytes(cert.read_bytes())
            (folder / "privkey.pem").write_bytes(key.read_bytes())
            turn_env = {**os.environ, "LIVEKIT_PUBLIC_IP": "192.0.2.20", "PUBLIC_MEDIA_HOST": "rtc.example.test", "TURN_PUBLIC_HOST": "turn.example.test", "TURN_SHARED_SECRET": "synthetic-turn-secret-isolated-test-20261103", "TURN_UID": str(os.getuid()), "TURN_GID": str(os.getgid()), "TURN_CERTIFICATE_DIR": str(folder), "LIVEKIT_PUBLIC_CONFIG": str(media)}
            for mode in ("true", "false"):
                target = folder / ("turn-" + mode)
                values = {**turn_env, "TURN_INGRESS_443": mode, "TURN_OUTPUT_DIR": str(target)}
                subprocess.run(["node", "scripts/prepare-turn.mjs"], cwd=ROOT, env=values, capture_output=True, check=True)
                config = (target / "turnserver.conf").read_text()
                advertised = (target / "livekit.yaml").read_text()
                assert all(p.stat().st_mode & 0o777 == 0o600 for p in target.iterdir())
                if mode == "true":
                    assert "listening-ip=127.0.0.1\n" in config and "relay-ip=192.0.2.20\n" in config
                    assert "port: 443\n" in advertised and "host: turn.example.test\n" in advertised
                    assert "protocol: udp" not in advertised and "port: 5349" not in advertised
                else:
                    assert "listening-ip=192.0.2.20\n" in config
                    assert "port: 5349\n" in advertised and "port: 3478\n" in advertised
            invalid = {**turn_env, "TURN_INGRESS_443": "true", "TURN_PUBLIC_HOST": "wrong.example.test", "TURN_OUTPUT_DIR": str(folder / "bad-turn")}
            assert subprocess.run(["node", "scripts/prepare-turn.mjs"], cwd=ROOT, env=invalid, capture_output=True).returncode != 0
            assert not (folder / "bad-turn").exists()
            passed("actual TURN preparation:443 loopback, legacy fallback, private files and certificate coverage")
            print(json.dumps({"passed": len(checks), "checks": checks, "realExternalMedia": False, "productionChanges": False}), flush=True)
        finally:
            subprocess.run(DOCKER + ["rm", "-f", name], capture_output=True)
            for process in processes:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            for server in servers:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        for captured in (error.stdout, error.stderr):
            if captured:
                print(captured.decode(errors="replace") if isinstance(captured, bytes) else captured, flush=True)
        raise
