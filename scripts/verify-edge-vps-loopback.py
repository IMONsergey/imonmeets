#!/usr/bin/env python3
"""Offline loopback harness for the f5eb135 edge candidate; no downloads/Docker.

Requires Python 3.10+, Node, OpenSSL and a trusted, preinstalled HAProxy 3.0.x.
--self-test validates only these fixtures. It never certifies HAProxy routing.
"""

import argparse
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import uuid


COMMIT = "f5eb135d30c650b6a32c39a9d4c8bf124ec9ce19"
SOURCE_HASHES = {
    "scripts/prepare-edge-vps-ingress.mjs": "8668b841bd9a2dcde7b8509494b9d7e1ffe60429e9486a35624c8b311fc91828",
    "scripts/prepare-ingress443.mjs": "9999b614d95e81662613a738163fb1fe0168b951c2ac5cc9eb537edd759bc866",
    "compose.edge-vps-ingress.yml": "8d079590bb2bf7f2f1fc0abea0396f5135d036efd56f00c94ac7c93928c0ce12",
}
FIXTURE = {
    "EDGE_PUBLIC_IP": "93.184.216.34",
    "VPN_PUBLIC_IP": "93.184.216.35",
    "EDGE_TUNNEL_LOCAL_IP": "10.255.254.1",
    "EDGE_MAIN_TUNNEL_IP": "10.255.254.2",
    "APP_URL": "https://app.example.test",
    "LIVEKIT_URL": "wss://rtc.example.test",
    "TURN_PUBLIC_HOST": "turn.example.test",
    "EDGE_WITNESS_HOST": "witness.example.test",
    "RECORDING_ENABLED": "true",
    "S3_PUBLIC_ENDPOINT": "https://recordings.example.test",
    "LIVEKIT_SIGNALING_AUTH_ENABLED": "true",
}
LOOPBACK = "127.0.0.1"
PROXY_SIGNATURE = b"\r\n\r\n\x00\r\nQUIT\n"


def require(condition, code):
    if not condition:
        raise AssertionError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def run(command, timeout=10):
    return subprocess.run(command, capture_output=True, timeout=timeout, check=False)


def write_private(path, data):
    with path.open("xb") as output:
        os.chmod(path, 0o600)
        output.write(data)


def generated_candidate(root, receipt):
    actual = {name: digest((root / name).read_bytes()) for name in SOURCE_HASHES}
    require(actual == SOURCE_HASHES, "CANDIDATE_SOURCE_HASH_MISMATCH")
    receipt["sourceHashes"] = actual
    node = shutil.which("node")
    require(node is not None, "NODE_UNAVAILABLE")
    bridge = (
        "const {buildEdgeVpsCandidate} = await import(process.argv[1]);"
        "process.stdout.write(JSON.stringify(buildEdgeVpsCandidate(JSON.parse(process.argv[2]))));"
    )
    result = run([
        node, "--input-type=module", "-e", bridge,
        (root / "scripts/prepare-edge-vps-ingress.mjs").as_uri(),
        json.dumps(FIXTURE),
    ])
    require(result.returncode == 0, "CANDIDATE_GENERATION_FAILED")
    candidate = json.loads(result.stdout)
    receipt["candidateConfigurationSha256"] = digest(candidate["haproxy"].encode())
    require(
        receipt["candidateConfigurationSha256"] == candidate["plan"]["haproxySha256"],
        "CANDIDATE_PLAN_HASH_MISMATCH",
    )
    receipt["expectedImage"] = candidate["plan"]["image"]
    return candidate["haproxy"]


def loopback_configuration(original, frontend_port, backend_ports):
    """Only six exact substitutions; ACLs, order, options and deadlines survive."""
    changes = [
        ("    user haproxy\n", ""),
        ("    group haproxy\n", ""),
        ("    bind 93.184.216.34:443\n", f"    bind {LOOPBACK}:{frontend_port}\n"),
        (
            "    server nginx 10.255.254.2:8445 send-proxy-v2 source 10.255.254.1\n",
            f"    server nginx {LOOPBACK}:{backend_ports['nginx']} send-proxy-v2 source {LOOPBACK}\n",
        ),
        (
            "    server turn 10.255.254.2:5349 source 10.255.254.1\n",
            f"    server turn {LOOPBACK}:{backend_ports['turn']} source {LOOPBACK}\n",
        ),
        (
            "    server witness_tls 127.0.0.1:8446\n",
            f"    server witness_tls {LOOPBACK}:{backend_ports['witness']}\n",
        ),
    ]
    adapted = original
    for before, after in changes:
        require(adapted.count(before) == 1, "UNEXPECTED_CONFIGURATION_SHAPE")
        adapted = adapted.replace(before, after)
    return adapted, [{"from": a.rstrip(), "to": b.rstrip()} for a, b in changes]


def connected(port, timeout=3):
    # Numeric AF_INET connect only; no resolver or configurable external target.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    try:
        sock.connect((LOOPBACK, port))
        return sock
    except BaseException:
        sock.close()
        raise


def receive_exact(sock, size):
    result = b""
    while len(result) < size:
        part = sock.recv(size - len(result))
        require(bool(part), "EARLY_EOF")
        result += part
    return result


def proxy_header(source, destination):
    addresses = struct.pack(
        "!4s4sHH", socket.inet_aton(source[0]), socket.inet_aton(destination[0]),
        source[1], destination[1],
    )
    return PROXY_SIGNATURE + b"\x21\x11" + struct.pack("!H", len(addresses)) + addresses


def receive_proxy_v2(sock):
    header = receive_exact(sock, 16)
    require(header[:12] == PROXY_SIGNATURE, "PROXY_V2_SIGNATURE_REQUIRED")
    require(header[12:14] == b"\x21\x11", "PROXY_V2_TCP_IPV4_REQUIRED")
    require(struct.unpack("!H", header[14:])[0] == 12, "PROXY_V2_ADDRESS_LENGTH_REQUIRED")
    src, dst, src_port, dst_port = struct.unpack("!4s4sHH", receive_exact(sock, 12))
    return {"source": [socket.inet_ntoa(src), src_port], "destination": [socket.inet_ntoa(dst), dst_port]}


def require_tls_prefix(sock):
    deadline = time.monotonic() + 3
    while True:
        prefix = sock.recv(5, socket.MSG_PEEK)
        if len(prefix) >= 5:
            break
        require(bool(prefix), "TLS_PREFIX_EOF")
        require(time.monotonic() < deadline, "TLS_PREFIX_DEADLINE")
        time.sleep(0.005)
    require(prefix[:2] == b"\x16\x03", "DIRECT_TLS_REQUIRED")


class Backend:
    def __init__(self, role, temp):
        self.role = role
        self.token = uuid.uuid4().hex.encode()
        self.lock = threading.Condition()
        self.accepted = 0
        self.events = []
        self.workers = []
        self.stopping = threading.Event()
        cert, key = temp / f"{role}.crt", temp / f"{role}.key"
        openssl = shutil.which("openssl")
        require(openssl is not None, "OPENSSL_UNAVAILABLE")
        generated = run([
            openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", f"/CN={role}.example.test",
        ])
        require(generated.returncode == 0, "FIXTURE_CERTIFICATE_GENERATION_FAILED")
        os.chmod(key, 0o600)
        self.cert = cert
        self.cert_sha256 = digest(ssl.PEM_cert_to_DER_cert(cert.read_text()))
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_2
        self.context.load_cert_chain(cert, key)
        self.context.set_servername_callback(
            lambda connection, name, _: setattr(connection, "fixture_sni", name)
        )
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind((LOOPBACK, 0))
        self.listener.listen(16)
        self.listener.settimeout(0.1)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stopping.is_set():
            try:
                connection, peer = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            with self.lock:
                self.accepted += 1
                sequence = self.accepted
            worker = threading.Thread(target=self.handle, args=(connection, peer, sequence), daemon=True)
            self.workers.append(worker)
            worker.start()

    def handle(self, connection, peer, sequence):
        event = {"sequence": sequence, "role": self.role, "peer": list(peer), "proxyV2": None}
        connection.settimeout(3)
        try:
            with connection:
                if self.role == "nginx":
                    event["proxyV2"] = receive_proxy_v2(connection)
                require_tls_prefix(connection)
                with self.context.wrap_socket(connection, server_side=True) as secured:
                    request = receive_exact(secured, 5)
                    require(request == b"ping\n", "FIXTURE_REQUEST_MISMATCH")
                    secured.sendall(self.role.encode() + b":" + self.token + b"\n")
                    event.update({"ok": True, "sni": getattr(secured, "fixture_sni", None), "tls": secured.version()})
        except Exception as error:
            event.update({"ok": False, "error": type(error).__name__, "code": str(error)[:100]})
        with self.lock:
            self.events.append(event)
            self.lock.notify_all()

    def wait_event(self, sequence):
        deadline = time.monotonic() + 4
        with self.lock:
            while True:
                match = next((e for e in self.events if e["sequence"] == sequence), None)
                if match is not None:
                    return match
                remaining = deadline - time.monotonic()
                require(remaining > 0, "FIXTURE_EVENT_DEADLINE")
                self.lock.wait(remaining)

    def count(self):
        with self.lock:
            return self.accepted

    def close(self):
        self.stopping.set()
        self.listener.close()
        self.thread.join(timeout=1)
        for worker in self.workers:
            worker.join(timeout=4)


def client_state(cert, hostname, tls12=False):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False  # Route identity is verified by a distinct pinned fixture certificate.
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_verify_locations(cafile=cert)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    if tls12:
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    session = context.wrap_bio(incoming, outgoing, server_hostname=hostname)
    try:
        session.do_handshake()
    except ssl.SSLWantReadError:
        pass
    hello = outgoing.read()
    require(hello[:2] == b"\x16\x03", "CLIENT_HELLO_NOT_EMITTED")
    return session, incoming, outgoing, hello


def send_hello(sock, hello, hostname, fragmented):
    if not fragmented:
        sock.sendall(hello)
        return []
    position = hello.find(hostname.encode())
    require(position > 5, "CLIENT_HELLO_SNI_NOT_FOUND")
    # Split the TLS record header and the SNI hostname itself across delayed writes.
    cuts = [1, 5, position + max(1, len(hostname) // 2), len(hello)]
    previous = 0
    for cut in cuts:
        sock.sendall(hello[previous:cut])
        previous = cut
        time.sleep(0.03)
    return cuts


def tls_exchange(port, backend, hostname, fragmented=False, direct_proxy=False, tls12=False):
    session, incoming, outgoing, hello = client_state(backend.cert, hostname, tls12)
    with connected(port) as sock:
        source, destination = sock.getsockname(), sock.getpeername()
        if direct_proxy:
            sock.sendall(proxy_header(source, destination))
        cuts = send_hello(sock, hello, hostname, fragmented)

        def feed():
            pending = outgoing.read()
            if pending:
                sock.sendall(pending)
            data = sock.recv(16384)
            require(bool(data), "TLS_EARLY_EOF")
            incoming.write(data)

        while True:
            try:
                session.do_handshake()
                break
            except ssl.SSLWantReadError:
                feed()
        require(digest(session.getpeercert(binary_form=True)) == backend.cert_sha256, "WRONG_BACKEND_CERTIFICATE")
        session.write(b"ping\n")
        pending = outgoing.read()
        if pending:
            sock.sendall(pending)
        response = b""
        while not response.endswith(b"\n"):
            try:
                chunk = session.read(256)
                require(bool(chunk), "TLS_APPLICATION_EOF")
                response += chunk
                require(len(response) <= 128, "FIXTURE_RESPONSE_TOO_LARGE")
            except ssl.SSLWantReadError:
                feed()
        require(response == backend.role.encode() + b":" + backend.token + b"\n", "WRONG_BACKEND_RESPONSE")
        return {"source": list(source), "destination": list(destination), "tls": session.version(), "fragmentCuts": cuts}


def counts(backends):
    return {role: backend.count() for role, backend in backends.items()}


def positive(backends, port, role, hostname, fragmented=False, direct=False, tls12=False):
    before = counts(backends)
    client = tls_exchange(port, backends[role], hostname, fragmented, direct and role == "nginx", tls12)
    event = backends[role].wait_event(before[role] + 1)
    require(event["ok"], "BACKEND_REJECTED_POSITIVE_CASE")
    require(event["sni"] == hostname, "ORIGINAL_SNI_NOT_PRESERVED")
    expected = dict(before)
    expected[role] += 1
    require(counts(backends) == expected, "UNEXPECTED_BACKEND_CONNECTION")
    if role == "nginx":
        require(event["proxyV2"] == {k: client[k] for k in ("source", "destination")}, "ORIGINAL_CLIENT_TUPLE_NOT_PRESERVED")
    else:
        require(event["proxyV2"] is None, "UNEXPECTED_PROXY_PROTOCOL")
    return {"sni": hostname, "backend": role, "tls": client["tls"], "fragmentCuts": client["fragmentCuts"], "proxyV2": role == "nginx"}


def rejected_connection(port, payload):
    start = time.monotonic()
    with connected(port, timeout=7) as sock:
        if payload:
            sock.sendall(payload)
        try:
            data = sock.recv(1)
            require(data == b"", "REJECTED_CASE_RECEIVED_BYTES")
            outcome = "EOF"
        except ConnectionResetError:
            outcome = "RESET"
        except socket.timeout:
            raise AssertionError("REJECT_DEADLINE_NOT_ENFORCED") from None
    elapsed = time.monotonic() - start
    require(elapsed < 7, "REJECT_DEADLINE_EXCEEDED")
    return {"outcome": outcome, "elapsedSeconds": round(elapsed, 3)}


def negative(backends, port, payload):
    before = counts(backends)
    result = rejected_connection(port, payload)
    time.sleep(0.05)
    require(counts(backends) == before, "REJECTED_CASE_REACHED_BACKEND")
    return {**result, "backendConnectionDelta": 0}


def record_check(receipt, name, callback):
    started = time.monotonic()
    try:
        details = callback()
    except Exception:
        receipt["checks"].append({"name": name, "status": "FAIL"})
        raise
    receipt["checks"].append({"name": name, "status": "PASS", "seconds": round(time.monotonic() - started, 3), "details": details})


def fixture_self_check(backends, original, receipt):
    ports = {role: backend.port for role, backend in backends.items()}
    adapted, rewrites = loopback_configuration(original, 24443, ports)
    require("tcp-request inspect-delay 5s" in adapted, "INSPECTION_DEADLINE_CHANGED")
    receipt["fixtureConfigurationRewrites"] = rewrites
    for role in backends:
        record_check(receipt, f"fixture-{role}-direct-tls", lambda role=role: positive(
            backends, backends[role].port, role, f"{role}.example.test", direct=True,
        ))
    record_check(receipt, "fixture-fragmented-client-hello", lambda: positive(
        backends, backends["turn"].port, "turn", "turn.example.test", fragmented=True, direct=True,
    ))
    record_check(receipt, "fixture-tls12", lambda: positive(
        backends, backends["nginx"].port, "nginx", "app.example.test", direct=True, tls12=True,
    ))

    def invalid_wire(role, payload, code):
        before = backends[role].count()
        result = rejected_connection(backends[role].port, payload)
        event = backends[role].wait_event(before + 1)
        require(not event["ok"] and event["code"] == code, "FIXTURE_NEGATIVE_ORACLE_FAILED")
        return result

    _, _, _, hello = client_state(backends["turn"].cert, "turn.example.test")
    header = proxy_header((LOOPBACK, 12345), (LOOPBACK, 23456))
    for role in ("turn", "witness"):
        record_check(receipt, f"fixture-{role}-rejects-proxy", lambda role=role: invalid_wire(
            role, header + hello, "DIRECT_TLS_REQUIRED",
        ))
    for label, broken, code in [
        ("missing-proxy", hello, "PROXY_V2_SIGNATURE_REQUIRED"),
        ("local-command", header[:12] + b"\x20" + header[13:] + hello, "PROXY_V2_TCP_IPV4_REQUIRED"),
        ("wrong-length", header[:14] + b"\x00\x0b" + header[16:] + hello, "PROXY_V2_ADDRESS_LENGTH_REQUIRED"),
    ]:
        record_check(receipt, f"fixture-nginx-rejects-{label}", lambda broken=broken, code=code: invalid_wire("nginx", broken, code))

    def wrong_certificate():
        before = counts(backends)
        try:
            tls_exchange(backends["turn"].port, backends["nginx"], "turn.example.test")
        except ssl.SSLCertVerificationError:
            event = backends["turn"].wait_event(before["turn"] + 1)
            require(not event["ok"], "WRONG_CERTIFICATE_UNEXPECTEDLY_ACCEPTED")
            return {"certificateMismatchRejected": True}
        raise AssertionError("WRONG_CERTIFICATE_UNEXPECTEDLY_ACCEPTED")

    record_check(receipt, "fixture-wrong-backend-certificate-rejected", wrong_certificate)


def runtime_check(binary, backends, original, output, receipt):
    identity = run([binary, "-vv"])
    version = identity.stdout.decode(errors="replace") + identity.stderr.decode(errors="replace")
    require(identity.returncode == 0 and re.search(r"HAProxy version 3\.0\.\d+", version), "HAPROXY_3_0_RUNTIME_REQUIRED")
    receipt["runtime"] = {"binarySha256": digest(Path(binary).read_bytes()), "versionOutputSha256": digest(version.encode()), "versionLine": version.splitlines()[0]}
    write_private(output / "haproxy-version.txt", version.encode())
    # -c does not bind the fixture public addresses. This also checks the real
    # haproxy user/group lookup; no users/groups are provisioned by this harness.
    original_check = run([binary, "-c", "-f", str(output / "candidate.cfg")])
    write_private(output / "original-syntax.log", original_check.stdout + original_check.stderr)
    receipt["gates"]["originalSyntax"] = "PASS" if original_check.returncode == 0 else "FAIL"
    require(original_check.returncode == 0, "ORIGINAL_SYNTAX_OR_RUNTIME_IDENTITY_FAILED")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind((LOOPBACK, 0))
        frontend_port = reservation.getsockname()[1]
        adapted, rewrites = loopback_configuration(original, frontend_port, {r: b.port for r, b in backends.items()})
        write_private(output / "loopback.cfg", adapted.encode())
        receipt["loopbackConfigurationSha256"] = digest(adapted.encode())
        receipt["configurationRewrites"] = rewrites
        parsed = run([binary, "-c", "-f", str(output / "loopback.cfg")])
        write_private(output / "loopback-syntax.log", parsed.stdout + parsed.stderr)
        require(parsed.returncode == 0, "LOOPBACK_SYNTAX_FAILED")
        receipt["gates"]["loopbackSyntax"] = "PASS"
    with (output / "haproxy.log").open("xb") as log:
        os.chmod(output / "haproxy.log", 0o600)
        process = subprocess.Popen([binary, "-db", "-f", str(output / "loopback.cfg")], stdout=log, stderr=subprocess.STDOUT)
        expected_accepts = {role: 0 for role in backends}
        try:
            deadline = time.monotonic() + 5
            while True:
                require(process.poll() is None, "HAPROXY_STARTUP_FAILED")
                try:
                    with connected(frontend_port, timeout=0.2):
                        break
                except ConnectionRefusedError:
                    require(time.monotonic() < deadline, "HAPROXY_STARTUP_DEADLINE")
                    time.sleep(0.05)
            require(sum(counts(backends).values()) == 0, "STARTUP_PROBE_REACHED_BACKEND")
            for host, role in [
                ("app.example.test", "nginx"), ("rtc.example.test", "nginx"),
                ("recordings.example.test", "nginx"), ("turn.example.test", "turn"),
                ("witness.example.test", "witness"), ("APP.EXAMPLE.TEST", "nginx"),
            ]:
                record_check(receipt, f"route-{host}", lambda host=host, role=role: positive(backends, frontend_port, role, host))
                expected_accepts[role] += 1
            for role, host in [("nginx", "app.example.test"), ("turn", "turn.example.test"), ("witness", "witness.example.test")]:
                record_check(receipt, f"fragmented-{role}", lambda role=role, host=host: positive(backends, frontend_port, role, host, fragmented=True))
                expected_accepts[role] += 1
            for role, host in [("nginx", "app.example.test"), ("turn", "turn.example.test")]:
                record_check(receipt, f"tls12-{role}", lambda role=role, host=host: positive(backends, frontend_port, role, host, tls12=True))
                expected_accepts[role] += 1
            for label, hostname in [
                ("foreign-sni", "foreign.example.test"),
                ("suffix-sni", "app.example.test.attacker.test"),
                ("trailing-dot-sni", "app.example.test."),
                ("missing-sni", None),
            ]:
                _, _, _, hello = client_state(backends["nginx"].cert, hostname)
                record_check(receipt, label, lambda hello=hello: negative(backends, frontend_port, hello))
            _, _, _, hello = client_state(backends["nginx"].cert, "app.example.test")
            for label, payload in [
                ("plain-http", b"GET / HTTP/1.1\r\nHost: app.example.test\r\n\r\n"),
                ("idle", b""), ("truncated-hello", hello[:32]),
                ("malformed-tls", b"\x16\x03\x01\x00\x03\x01\x00\x00"),
            ]:
                record_check(receipt, label, lambda payload=payload: negative(backends, frontend_port, payload))
            require(process.poll() is None, "HAPROXY_EXITED_DURING_TEST")
            require(counts(backends) == expected_accepts, "EXTRA_BACKEND_CONNECTION")
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        time.sleep(0.1)
        require(counts(backends) == expected_accepts, "LATE_BACKEND_CONNECTION")
        receipt["gates"]["realHaproxyLoopbackRouting"] = "PASS"
        receipt["backendAccepts"] = counts(backends)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path, required=True, help="new absolute evidence directory")
    parser.add_argument("--haproxy", help="trusted preinstalled HAProxy 3.0.x executable")
    parser.add_argument("--self-test", action="store_true", help="test fixtures only; never HAProxy acceptance")
    args = parser.parse_args()
    require(args.output.is_absolute(), "ABSOLUTE_OUTPUT_REQUIRED")
    args.output.mkdir(mode=0o700)
    receipt = {
        "schema": 1, "candidateCommit": COMMIT,
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "executionUid": os.getuid(), "executionEuid": os.geteuid(),
        "harnessSha256": digest(Path(__file__).read_bytes()),
        "pythonOpenSsl": ssl.OPENSSL_VERSION,
        "status": "FAIL_VALIDATION", "checks": [],
        "gates": {"originalSyntax": "PENDING", "loopbackSyntax": "PENDING", "realHaproxyLoopbackRouting": "PENDING", "pinnedImageRuntime": "PENDING"},
        "productionChanges": False, "externalNetworkRequests": False,
        "userKeysUsed": False, "dnsChanged": False, "tunnelsConfigured": False,
        "public443Accepted": False, "mainNginxOrTurnAccepted": False,
    }
    exit_code = 1
    try:
        original = generated_candidate(args.repo_root.resolve(), receipt)
        write_private(args.output / "candidate.cfg", original.encode())
        binary = shutil.which(args.haproxy or "haproxy")
        if not args.self_test and not binary:
            receipt["status"] = "BLOCKED_HAPROXY_RUNTIME_UNAVAILABLE"
            receipt["runtimeDiscovery"] = {name: shutil.which(name) for name in ("haproxy", "docker", "podman", "node", "openssl")}
            exit_code = 2
        else:
            with tempfile.TemporaryDirectory(prefix="imon-edge-loopback-") as temporary, contextlib.ExitStack() as cleanup:
                backends = {}
                for role in ("nginx", "turn", "witness"):
                    backend = Backend(role, Path(temporary))
                    cleanup.callback(backend.close)
                    backends[role] = backend
                if args.self_test:
                    fixture_self_check(backends, original, receipt)
                    receipt["status"] = "PASS_FIXTURE_SELF_CHECK_ONLY"
                else:
                    runtime_check(str(Path(binary).resolve()), backends, original, args.output, receipt)
                    receipt["status"] = "PASS_NATIVE_LOOPBACK_ROUTING_PINNED_IMAGE_PENDING"
                exit_code = 0
            receipt["fixtureCertificatesRemoved"] = not Path(temporary).exists()
    except Exception as error:
        receipt["error"] = {"type": type(error).__name__, "code": str(error)[:160]}
    receipt["completedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_private(args.output / "receipt.json", (json.dumps(receipt, indent=2) + "\n").encode())
    print(json.dumps({"status": receipt["status"], "checksPassed": sum(c["status"] == "PASS" for c in receipt["checks"]), "checksFailed": sum(c["status"] == "FAIL" for c in receipt["checks"]), "receipt": str(args.output / "receipt.json"), "exitCode": exit_code}))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
