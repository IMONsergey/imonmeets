#!/usr/bin/env python3
"""Bounded, disposable IPv4 WireGuard acceptance test; never a live installer.

--self-check uses no subprocesses, sockets, namespaces, or real keys.
--run needs root, iproute2, nftables, wireguard-tools and Linux netns support.
Only the two UUID-named namespaces are created from the caller's namespace.
The veth pair is born inside edge; its peer moves directly into main. All test
network operations, keys and services run through ``ip netns exec``. The only
other host commands are a fixed read-only address/route/rule/nft snapshot whitelist.
No host interface, address, default route, firewall rule, sysctl or service is
modified. SIGINT/SIGTERM and ordinary failures clean up owned resources;
SIGKILL/power loss cannot be made cleanup-safe by a userspace process.
"""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
GENERATOR = HERE.with_name("prepare-edge-transport.py")
PORTS = [5349, 8445, 18080]
DENIED_PORT = 8446
WG = "wg-meets"
WAN = "wan0"
WG_PORT = 21843
ROUTE_TABLE = 51843
RULE_PRIORITY = 11000
GUARD = "imon_meets_transport"
LATER_FILTER = "imon_netns_later_filter"
ROLES = ("edge", "main")
PUBLIC = {"edge": "93.184.216.33", "main": "93.184.216.34"}
PRIVATE = {"edge": "10.203.77.1", "main": "10.203.77.2"}
CHECKS = ("capturePositiveControl", "realNftSyntaxAndKernelApply",
          "healthyWithLaterDropFirewall", "healthyNoWanLeak",
          "deniedOtherListeningPort", "deniedWrongSource", "deniedTrafficNoWanLeak",
          "linkDownRetainsGuardNoWanLeak", "linkUpRecovery",
          "interfaceDeletedTerminalUnreachableNoWanLeak",
          "policyRemovedUnboundDefaultFallbackNoWanLeak", "hostNetworkPreservation",
          "ownedResourceCleanup")


class VerificationError(Exception):
    def __init__(self, code, returncode=None, unavailable=False):
        super().__init__(code)
        self.code, self.returncode, self.unavailable = code, returncode, unavailable


def require(condition, code):
    if not condition:
        raise VerificationError(code)


def generator():
    loader = importlib.util.spec_from_file_location("imon_transport_generator", GENERATOR)
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    return module


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data if isinstance(data, bytes) else data.encode())


def spec_for(keys):
    spec = {"schema": 1, "interface": WG, "routeTable": ROUTE_TABLE,
            "rulePriority": RULE_PRIORITY, "mtu": 1380}
    for role in ROLES:
        spec[role] = {"publicIp": PUBLIC[role], "tunnelIp": PRIVATE[role],
                      "publicKey": keys[role], "listenPort": WG_PORT, "wanInterface": WAN}
    return spec


def expected_plan(role):
    peer = "main" if role == "edge" else "edge"
    base = "/etc/imonmeets/transport/" + WG
    return [
        ["/usr/sbin/nft", "--check", "--file", base + "/guard.nft"],
        ["/usr/sbin/nft", "--file", base + "/guard.nft"],
        ["/usr/bin/ip", "-4", "route", "add", "unreachable", PRIVATE[peer] + "/32", "table", str(ROUTE_TABLE), "metric", "42760"],
        ["/usr/bin/ip", "-4", "rule", "add", "priority", str(RULE_PRIORITY), "to", PRIVATE[peer] + "/32", "lookup", str(ROUTE_TABLE)],
        ["/usr/bin/ip", "link", "add", "dev", WG, "type", "wireguard"],
        ["/usr/bin/wg", "setconf", WG, base + "/peer.conf"],
        ["/usr/bin/wg", "set", WG, "private-key", base + "/private.key"],
        ["/usr/bin/ip", "address", "add", PRIVATE[role] + "/32", "dev", WG],
        ["/usr/bin/ip", "link", "set", "dev", WG, "mtu", "1380", "up"],
        ["/usr/bin/ip", "-4", "route", "add", PRIVATE[peer] + "/32", "dev", WG, "src", PRIVATE[role], "table", str(ROUTE_TABLE), "metric", "10"],
    ]


def mapped_plan(plan, role, directory, binaries):
    commands = plan["hostPlans"][role]["guardThenRouteThenInterface"]
    require(commands == expected_plan(role), "GENERATOR_PLAN_CHANGED_REVIEW_REQUIRED")
    base = "/etc/imonmeets/transport/" + WG
    mapping = {base + "/" + name: str(directory / role / name)
               for name in ("guard.nft", "peer.conf", "private.key")}
    return [[binaries[Path(command[0]).name]] + [mapping.get(v, v) for v in command[1:]]
            for command in commands]


def active_edge_route_present(routes):
    """Accept only the two reviewed peer routes; never adopt a different path."""
    active = []
    for route in routes:
        require(route.get("dst") in (PRIVATE["main"], PRIVATE["main"] + "/32"), "RECOVERY_ROUTE_DESTINATION_CHANGED")
        if route.get("type") == "unreachable" and route.get("metric") == 42760:
            continue
        require(route.get("type", "unicast") == "unicast" and route.get("dev") == WG
                and route.get("prefsrc", route.get("src")) == PRIVATE["edge"]
                and route.get("metric") == 10 and not route.get("gateway"),
                "RECOVERY_ACTIVE_ROUTE_CHANGED")
        active.append(route)
    require(len(active) <= 1, "RECOVERY_ACTIVE_ROUTE_AMBIGUOUS")
    return len(active) == 1


def stable(value, kind="", parent=""):
    """Ignore runtime counters/expiry, never rule expressions or rule order."""
    if isinstance(value, list):
        return [stable(v, kind, parent) for v in value
                if not (kind == "nft" and isinstance(v, dict) and set(v) == {"metainfo"})]
    if isinstance(value, dict):
        return {k: stable(v, kind, k) for k, v in value.items()
                if not (kind == "nft" and parent == "counter" and k in ("packets", "bytes"))
                and not (kind == "nft" and k == "expires")
                and not (kind == "address" and k in ("valid_life_time", "preferred_life_time"))
                and not (kind == "route" and k in ("cache", "expires", "used", "age", "lastuse"))}
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ipv4_frame(frame):
    if len(frame) < 14:
        return None
    ether, start = struct.unpack("!H", frame[12:14])[0], 14
    for _ in range(2):
        if ether not in (0x8100, 0x88A8) or len(frame) < start + 4:
            break
        ether, start = struct.unpack("!H", frame[start + 2:start + 4])[0], start + 4
    if ether != 0x0800 or len(frame) < start + 20:
        return None
    ihl = (frame[start] & 15) * 4
    if frame[start] >> 4 != 4 or ihl < 20 or len(frame) < start + ihl:
        return None
    return frame[start + 12:start + 16], frame[start + 16:start + 20], frame[start + 9]


def private_ipv4(raw):
    n = int.from_bytes(raw, "big")
    return n >> 24 == 10 or n >> 20 == 0xAC1 or n >> 16 == 0xC0A8


def helper_isolated(args):
    inode = os.stat("/proc/self/ns/net").st_ino
    require(args.namespace_inode and args.host_inode and
            inode == args.namespace_inode and inode != args.host_inode,
            "HELPER_REQUIRES_OWNED_ISOLATED_NAMESPACE")


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def capture_helper(args):
    helper_isolated(args)
    deadline = time.monotonic() + args.duration
    stats = {name: 0 for name in ("frames", "ipv4", "privateIpv4", "txPrivateIpv4",
                                  "rxPrivateIpv4", "udpIpv4", "kernelPackets", "kernelDrops")}
    with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(3)) as sniffer:
        sniffer.bind((WAN, 0))
        sniffer.setblocking(False)

        def drain():
            for _ in range(4096):
                try:
                    frame, sender = sniffer.recvfrom(65535)
                except BlockingIOError:
                    break
                stats["frames"] += 1
                parsed = ipv4_frame(frame)
                if parsed:
                    src, dst, protocol = parsed
                    stats["ipv4"] += 1
                    stats["udpIpv4"] += protocol == 17
                    if private_ipv4(src) or private_ipv4(dst):
                        stats["privateIpv4"] += 1
                        stats["txPrivateIpv4" if sender[2] == 4 else "rxPrivateIpv4"] += 1

        emit({"ready": True, "helper": "capture"})
        pending = b""
        while time.monotonic() < deadline:
            ready, _, _ = select.select([sniffer, sys.stdin.buffer], [], [], min(0.2, deadline - time.monotonic()))
            if sniffer in ready:
                drain()
            if sys.stdin.buffer in ready:
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    return
                pending += chunk
                require(len(pending) < 16384, "CAPTURE_CONTROL_TOO_LARGE")
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    request = json.loads(line)
                    drain()
                    # SOL_PACKET/PACKET_STATISTICS; reading resets these kernel counters.
                    received, dropped = struct.unpack("II", sniffer.getsockopt(263, 6, 8))
                    stats["kernelPackets"] += received
                    stats["kernelDrops"] += dropped
                    emit({"id": request["id"], "stats": stats})
                    if request.get("stop"):
                        return


def echo_helper(args):
    helper_isolated(args)
    listeners = []
    try:
        for port in PORTS + [DENIED_PORT]:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind((PRIVATE["main"], port))
            listener.listen(8)
            listener.setblocking(False)
            listeners.append(listener)
        emit({"ready": True, "ports": PORTS + [DENIED_PORT]})
        deadline = time.monotonic() + args.duration
        while time.monotonic() < deadline:
            ready, _, _ = select.select(listeners, [], [], min(0.2, deadline - time.monotonic()))
            for listener in ready:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(0.5)
                    try:
                        while True:
                            payload = connection.recv(256)
                            if not payload:
                                break
                            connection.sendall(payload)
                    except OSError:
                        pass
    finally:
        for listener in listeners:
            listener.close()


def probe_helper(args):
    helper_isolated(args)
    result = {"connected": False, "echoed": False, "stage": "bind", "errno": None}
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(args.duration)
        try:
            if args.source:
                client.bind((args.source, 0))
            result["stage"] = "connect"
            client.connect((PRIVATE["main"], args.port))
            result["connected"], result["source"] = True, client.getsockname()[0]
            result["stage"] = "echo"
            payload = b"imon-transport-netns-acceptance"
            client.sendall(payload)
            received = b""
            while len(received) < len(payload):
                part = client.recv(len(payload) - len(received))
                if not part:
                    break
                received += part
            result["echoed"] = received == payload
        except OSError as error:
            result["errno"] = error.errno
    emit(result)


def control_helper(args):
    helper_isolated(args)
    # Before guards/WG exist, exercise the real namespace default route and
    # prove both AF_PACKET monitors see RFC1918 destinations. TTL=1 prevents
    # a forwarding loop even if a namespace inherits forwarding enabled.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
        client.setsockopt(socket.IPPROTO_IP, socket.IP_TTL, 1)
        sent = client.sendto(b"capture-positive-control", (PRIVATE["main"], 41999))
    emit({"sent": sent})


class Harness:
    def __init__(self, output, seconds):
        self.output = output
        self.started = time.monotonic()
        self.end = self.started + seconds
        self.deadline = self.end - 25
        self.token = uuid.uuid4().hex
        self.names = {role: "imon-test-" + role + "-" + self.token for role in ROLES}
        self.owned = set()
        self.inodes = {}
        self.children = []
        self.captures = {}
        self.counter_id = 0
        self.directory = None
        self.host_inode = os.stat("/proc/self/ns/net").st_ino
        self.binaries = {name: shutil.which(name) for name in ("ip", "nft", "wg", "ss")}
        self.report = {
            "schema": 1, "status": "PENDING", "checks": {name: {"status": "PENDING"} for name in CHECKS}, "namespaces": self.names,
            "deadlineSeconds": seconds, "udpPort": WG_PORT, "allowedTcpPorts": PORTS,
            "hostRoutingOrFirewallChangesRequested": False, "privateKeysWrittenToReceipt": False,
            "liveTunnelAccepted": False, "public443Accepted": False,
            "ipv6RuntimeAccepted": False, "forwardingRuntimeAccepted": False,
            "bootPersistenceAccepted": False, "temporaryKeysCreated": False,
            "scope": "disposable IPv4 namespace transport, later INPUT DROP, failure and fallback",
            "isolatedIpv4ConfinementAccepted": False,
            "simulatedExistingMainPolicy": "priority 32765, not fwmark 0x100cf, empty table 65743",
        }

    def remaining(self, limit=6):
        left = self.deadline - time.monotonic()
        require(left > 0, "DEADLINE_EXCEEDED")
        return min(limit, left)

    def command(self, argv, code, role=None, allow_failure=False, data=None, timeout=6):
        if role:
            require(role in self.owned and os.stat("/run/netns/" + self.names[role]).st_ino == self.inodes[role], "NAMESPACE_OWNERSHIP_LOST")
            argv = [self.binaries["ip"], "netns", "exec", self.names[role]] + argv
        process = subprocess.Popen(argv, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            stdout, stderr = process.communicate(input=data, timeout=self.remaining(timeout))
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=1)
            raise
        if process.returncode and not allow_failure:
            unavailable = any(v in stderr.lower() for v in
                              (b"operation not permitted", b"operation not supported", b"unknown device type"))
            raise VerificationError(code, process.returncode, unavailable)
        return process.returncode, stdout

    def ns(self, role, name, *args, code="NAMESPACE_COMMAND_FAILED", **kwargs):
        return self.command([self.binaries[name], *args], code, role, **kwargs)

    def ns_json(self, role, name, *args, **kwargs):
        return json.loads(self.ns(role, name, *args, **kwargs)[1])

    def snapshot_host(self):
        # The complete host command whitelist; every command here is read-only.
        requested = {
            "addresses": ("address", [self.binaries["ip"], "-j", "address", "show"]),
            "ipv4Routes": ("route", [self.binaries["ip"], "-4", "-j", "route", "show", "table", "all"]),
            "ipv6Routes": ("route", [self.binaries["ip"], "-6", "-j", "route", "show", "table", "all"]),
            "ipv4Rules": ("rule", [self.binaries["ip"], "-4", "-j", "rule", "show"]),
            "ipv6Rules": ("rule", [self.binaries["ip"], "-6", "-j", "rule", "show"]),
            "nftRuleset": ("nft", [self.binaries["nft"], "--json", "list", "ruleset"]),
        }
        return {name: digest(stable(json.loads(self.command(argv, "HOST_SNAPSHOT_FAILED", timeout=3)[1]), kind))
                for name, (kind, argv) in requested.items()}

    def read_child(self, process, code, timeout=5):
        ready, _, _ = select.select([process.stdout], [], [], self.remaining(timeout))
        require(bool(ready), code)
        line = process.stdout.readline(65537)
        require(line.endswith(b"\n") and len(line) < 65537, code)
        return json.loads(line)

    def helper_args(self, role, helper, duration, extra=()):
        return [sys.executable, str(HERE), "--_helper", helper, "--host-inode", str(self.host_inode),
                "--namespace-inode", str(self.inodes[role]), "--duration", str(duration), *extra]

    def start_helper(self, role, helper):
        argv = [self.binaries["ip"], "netns", "exec", self.names[role]] + self.helper_args(role, helper, self.remaining(120))
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True, bufsize=0)
        self.children.append(process)
        require(self.read_child(process, helper.upper() + "_UNAVAILABLE").get("ready") is True,
                helper.upper() + "_UNAVAILABLE")
        return process

    def probe(self, port, source=None, timeout=0.7):
        extra = ["--port", str(port)] + (["--source", source] if source else [])
        _, raw = self.command(self.helper_args("edge", "probe", timeout, extra),
                              "PROBE_HELPER_FAILED", "edge", timeout=timeout + 2)
        return json.loads(raw)

    def healthy(self, port):
        result = self.probe(port, PRIVATE["edge"], 4)
        if not (result["connected"] and result["echoed"] and result.get("source") == PRIVATE["edge"]):
            failure = {"port": port, "expectedSource": PRIVATE["edge"], "probe": result}
            self.report["failedHealthyProbe"] = failure
            try:
                failure["peerTableRoutes"] = self.ns_json("edge", "ip", "-4", "-j", "route", "show", "table", str(ROUTE_TABLE))
                rc, raw = self.ns("edge", "ip", "-4", "-j", "route", "get", PRIVATE["main"], "from", PRIVATE["edge"], allow_failure=True)
                failure["sourceBoundRouteLookup"] = {"exit": rc, "routes": json.loads(raw) if rc == 0 else []}
            except (OSError, ValueError, VerificationError, subprocess.SubprocessError):
                failure["diagnosticsIncomplete"] = True
            raise VerificationError("HEALTHY_TCP_" + str(port) + "_FAILED")
        return result

    def denied(self, port, source=None):
        result = self.probe(port, source)
        require(result["stage"] == "connect" and not result["connected"], "EXPECTED_TCP_DENIAL_FAILED")
        return result

    def counters(self):
        time.sleep(min(0.06, self.remaining()))
        results = {}
        for role, process in self.captures.items():
            self.counter_id += 1
            process.stdin.write((json.dumps({"id": self.counter_id}) + "\n").encode())
            process.stdin.flush()
            result = self.read_child(process, "CAPTURE_SNAPSHOT_FAILED")
            require(result.get("id") == self.counter_id, "CAPTURE_RESPONSE_MISMATCH")
            require(result["stats"]["kernelDrops"] == 0, "CAPTURE_DROPPED_PACKETS")
            results[role] = result["stats"]
        return results

    def no_leaks(self, label):
        current = self.counters()
        require(all(current[role]["privateIpv4"] == self.capture_baseline[role]["privateIpv4"]
                    for role in ROLES), "PRIVATE_IPV4_LEAK_" + label.upper())
        self.report["checks"][label] = {"status": "PASS", "newPrivateIpv4Frames": 0, "captures": current}

    def retained_guard(self):
        tables = self.ns_json("edge", "nft", "--json", "list", "tables")
        require(any(x.get("table", {}).get("name") == GUARD for x in tables["nftables"]), "GUARD_DID_NOT_PERSIST")
        routes = self.ns_json("edge", "ip", "-4", "-j", "route", "show", "table", str(ROUTE_TABLE))
        require(any(r.get("type") == "unreachable" and r.get("dst") in (PRIVATE["main"], PRIVATE["main"] + "/32")
                    and r.get("metric") == 42760 for r in routes), "TERMINAL_ROUTE_DID_NOT_PERSIST")
        rules = self.ns_json("edge", "ip", "-4", "-j", "rule", "show")
        require(any(r.get("priority") == RULE_PRIORITY and str(r.get("table")) == str(ROUTE_TABLE)
                    and r.get("dst") in (PRIVATE["main"], PRIVATE["main"] + "/32") for r in rules), "PEER_RULE_DID_NOT_PERSIST")
        return routes

    def nft_file(self, role, name, contents):
        path = self.directory / role / name
        private_write(path, contents)
        self.ns(role, "nft", "--check", "--file", str(path), code="NFT_SYNTAX_" + role.upper() + "_FAILED")
        self.ns(role, "nft", "--file", str(path), code="NFT_LOAD_" + role.upper() + "_FAILED")

    def exercise(self):
        require(os.geteuid() == 0 and sys.platform == "linux", "ROOT_LINUX_REQUIRED")
        require(all(self.binaries.values()), "REQUIRED_TOOL_UNAVAILABLE")
        self.report["hostBefore"] = self.snapshot_host()
        self.directory = Path(tempfile.mkdtemp(prefix="imon-netns-", dir=self.output.parent))
        for role in ROLES:
            (self.directory / role).mkdir(mode=0o700)
            path = Path("/run/netns") / self.names[role]
            require(not os.path.lexists(path), "NAMESPACE_NAME_COLLISION")
            # Claim only our fresh, unpredictable name before creation so that
            # even an interrupted create attempt can be cleaned up safely.
            self.owned.add(role)
            self.command([self.binaries["ip"], "netns", "add", self.names[role]], "NETNS_CREATE_" + role.upper() + "_FAILED")
            self.inodes[role] = path.stat().st_ino
            require(self.inodes[role] != self.host_inode, "NAMESPACE_IS_NOT_ISOLATED")
        self.ns("edge", "ip", "link", "add", WAN, "type", "veth", "peer", "name", "peer0")
        self.ns("edge", "ip", "link", "set", "dev", "peer0", "netns", self.names["main"])
        self.ns("main", "ip", "link", "set", "dev", "peer0", "name", WAN)
        for role in ROLES:
            peer = "main" if role == "edge" else "edge"
            self.ns(role, "ip", "link", "set", "dev", "lo", "up")
            self.ns(role, "ip", "address", "add", PUBLIC[role] + "/30", "dev", WAN)
            self.ns(role, "ip", "link", "set", "dev", WAN, "up")
            self.ns(role, "ip", "-4", "route", "add", "default", "via", PUBLIC[peer], "dev", WAN)
            self.captures[role] = self.start_helper(role, "capture")
        self.ns("main", "ip", "-4", "rule", "add", "priority", "32765", "not", "fwmark", "0x100cf", "lookup", "65743")
        self.command(self.helper_args("edge", "control", 1), "CAPTURE_CONTROL_FAILED", "edge")
        self.capture_baseline = self.counters()
        require(self.capture_baseline["edge"]["txPrivateIpv4"] > 0 and
                self.capture_baseline["main"]["rxPrivateIpv4"] > 0, "CAPTURE_POSITIVE_CONTROL_FAILED")
        self.report["checks"]["capturePositiveControl"] = {"status": "PASS", "captures": self.capture_baseline}

        keys, inventories = {}, {}
        for role in ROLES:
            peer = "main" if role == "edge" else "edge"
            key = self.ns(role, "wg", "genkey", code="TEMPORARY_KEY_GENERATION_FAILED")[1]
            private_write(self.directory / role / "private.key", key)
            keys[role] = self.ns(role, "wg", "pubkey", data=key, code="PUBLIC_KEY_DERIVATION_FAILED")[1].decode().strip()
            del key
            self.report["temporaryKeysCreated"] = True
            inventory = self.directory / role / "inventory.json"
            self.command([sys.executable, str(GENERATOR), "inventory", "--role", role,
                          "--peer-public-ip", PUBLIC[peer], "--output", str(inventory)],
                         "ISOLATED_INVENTORY_FAILED", role)
            inventories[role] = json.loads(inventory.read_text())
            require(inventories[role].get("nftTables") == [], "ISOLATED_FIREWALL_NOT_EMPTY")
        files, plan = generator().build_candidate(spec_for(keys), inventories)
        require(plan["allowedTcpDestinationPortsOnMain"] == PORTS, "GENERATOR_ALLOWED_PORTS_CHANGED")
        self.report["candidateFileSha256"] = plan["fileSha256"]
        for role in ROLES:
            for name in ("guard.nft", "peer.conf"):
                private_write(self.directory / role / name, files[role + "/" + name])
            for index, command in enumerate(mapped_plan(plan, role, self.directory, self.binaries)):
                self.command(command, "CANDIDATE_" + role.upper() + "_STEP_" + str(index) + "_FAILED", role)
        self.report["checks"]["realNftSyntaxAndKernelApply"] = {"status": "PASS"}
        self.start_helper("main", "echo")
        self.nft_file("main", "later-filter.nft", f'''table inet {LATER_FILTER} {{
 chain input {{
  type filter hook input priority 0; policy drop;
  iifname "{WAN}" ip saddr {PUBLIC['edge']} ip daddr {PUBLIC['main']} udp sport {WG_PORT} udp dport {WG_PORT} accept
 }}
}}
''')
        missing_allow = self.denied(8445, PRIVATE["edge"])
        self.nft_file("main", "later-allow.nft", f'''add rule inet {LATER_FILTER} input iifname "{WG}" ip saddr {PRIVATE['edge']} ip daddr {PRIVATE['main']} tcp dport {{ 5349, 8445, 18080 }} ct state {{ new, established }} accept
''')
        healthy = {str(port): self.healthy(port) for port in PORTS}
        for role in ROLES:
            handshake = self.ns(role, "wg", "show", WG, "latest-handshakes")[1].decode().split()
            require(len(handshake) == 2 and handshake[1].isdigit() and int(handshake[1]) > 0, "HANDSHAKE_NOT_OBSERVED")
        self.report["checks"]["healthyWithLaterDropFirewall"] = {"status": "PASS", "tcp": healthy, "handshakesObserved": True, "withoutExplicitTcpAllow": missing_allow}
        self.no_leaks("healthyNoWanLeak")
        # Remove our simulated later firewall, so the next negative test proves
        # the generated guard itself rejects a port with a live echo listener.
        self.ns("main", "nft", "delete", "table", "inet", LATER_FILTER)
        self.report["checks"]["deniedOtherListeningPort"] = {"status": "PASS", "probe": self.denied(DENIED_PORT, PRIVATE["edge"])}
        self.report["checks"]["deniedWrongSource"] = {"status": "PASS", "probe": self.denied(8445, PUBLIC["edge"])}
        self.no_leaks("deniedTrafficNoWanLeak")
        self.ns("edge", "ip", "link", "set", "dev", WG, "down")
        down_routes = self.retained_guard()
        self.denied(8445)
        self.no_leaks("linkDownRetainsGuardNoWanLeak")
        self.report["checks"]["linkDownRetainsGuardNoWanLeak"]["peerTableRoutes"] = down_routes
        self.ns("edge", "ip", "link", "set", "dev", WG, "up")
        up_routes = self.retained_guard()
        recovery = {"status": "PENDING", "routesBeforeRecovery": up_routes,
                    "method": "link-up-and-reapply-reviewed-source-bound-peer-route",
                    "activeRouteReinstalled": False}
        self.report["checks"]["linkUpRecovery"] = recovery
        # Administrative NETDEV_DOWN may flush routes using the link. NETDEV_UP
        # restores address routes, not our explicit route in the private table.
        # Recover only the exact generated final /32+src+metric10 command. The
        # terminal unreachable route, peer rule and nft guards remain throughout.
        if not active_edge_route_present(up_routes):
            command = mapped_plan(plan, "edge", self.directory, self.binaries)[-1]
            self.command(command, "RECOVERY_PEER_ROUTE_REINSTALL_FAILED", "edge")
            recovery["activeRouteReinstalled"] = True
        recovered_routes = self.retained_guard()
        require(active_edge_route_present(recovered_routes), "RECOVERY_ACTIVE_ROUTE_MISSING")
        recovery["routesAfterRecovery"] = recovered_routes
        recovery["probe"] = self.healthy(8445)
        recovery["status"] = "PASS"
        self.no_leaks("recoveredLinkNoWanLeak")
        stop = plan["hostPlans"]["edge"]["stopOnlyOwnedInterfaceAfterStoppingIngress"]
        require(stop == ["/usr/bin/ip", "link", "delete", "dev", WG], "GENERATOR_STOP_PLAN_CHANGED")
        self.ns("edge", "ip", *stop[1:])
        routes = self.retained_guard()
        require(not any(r.get("dev") == WG for r in routes), "DELETED_INTERFACE_ROUTE_REMAINS")
        rc, _ = self.ns("edge", "ip", "-4", "route", "get", PRIVATE["main"], allow_failure=True)
        require(rc != 0, "TERMINAL_ROUTE_DID_NOT_STOP_FALLBACK")
        self.denied(8445)
        self.no_leaks("interfaceDeletedTerminalUnreachableNoWanLeak")
        self.ns("edge", "ip", "-4", "rule", "delete", "priority", str(RULE_PRIORITY), "to", PRIVATE["main"] + "/32", "lookup", str(ROUTE_TABLE))
        fallback = self.ns_json("edge", "ip", "-4", "-j", "route", "get", PRIVATE["main"])
        require(len(fallback) == 1 and fallback[0].get("dev") == WAN and
                fallback[0].get("prefsrc", fallback[0].get("src")) == PUBLIC["edge"], "DEFAULT_FALLBACK_NOT_EXERCISED")
        for port in PORTS:
            self.denied(port)  # Deliberately unbound: source becomes the WAN IPv4.
        self.no_leaks("policyRemovedUnboundDefaultFallbackNoWanLeak")
        self.report["checks"]["policyRemovedUnboundDefaultFallbackNoWanLeak"]["selectedRoute"] = fallback

    def cleanup(self):
        self.deadline = self.end
        errors = []
        for child in reversed(self.children):
            try:
                if child.poll() is None:
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=0.5)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait(timeout=1)
            except (OSError, subprocess.SubprocessError):
                errors.append("HELPER_CLEANUP_FAILED")
            finally:
                for stream in (child.stdin, child.stdout):
                    if stream:
                        try:
                            stream.close()
                        except OSError:
                            errors.append("HELPER_STREAM_CLEANUP_FAILED")
        for role in reversed(ROLES):
            if role not in self.owned:
                continue
            path = Path("/run/netns") / self.names[role]
            try:
                if os.path.lexists(path):
                    # Inode is known after successful creation. A failed create
                    # may leave our claimed mount; never remove the host netns.
                    actual = path.stat().st_ino
                    require(actual != self.host_inode and (role not in self.inodes or actual == self.inodes[role]), "CLEANUP_OWNERSHIP_MISMATCH")
                    self.command([self.binaries["ip"], "netns", "delete", self.names[role]], "NAMESPACE_CLEANUP_FAILED", timeout=2)
                require(not os.path.lexists(path), "NAMESPACE_CLEANUP_INCOMPLETE")
            except (OSError, VerificationError, subprocess.SubprocessError) as error:
                errors.append(error.code if isinstance(error, VerificationError) else "CLEANUP_IO_FAILED")
        if self.directory:
            try:
                shutil.rmtree(self.directory)
            except OSError:
                errors.append("PRIVATE_TEMPFILES_CLEANUP_FAILED")
        self.report["cleanup"] = {"status": "PASS" if not errors else "FAIL", "errors": errors,
                                  "temporaryFilesRemoved": self.directory is None or not self.directory.exists()}
        self.report["checks"]["ownedResourceCleanup"] = {"status": "PASS" if not errors else "FAIL"}
        if "hostBefore" in self.report:
            try:
                after = self.snapshot_host()
                self.report["hostAfter"] = after
                self.report["hostRoutesRulesNftUnchanged"] = self.report["hostBefore"] == after
                self.report["hostAddressesRoutesRulesNftUnchanged"] = self.report["hostBefore"] == after
                self.report["nftRuntimeCountersExcludedFromHash"] = True
                require(self.report["hostRoutesRulesNftUnchanged"], "HOST_NETWORK_SNAPSHOT_CHANGED")
                self.report["checks"]["hostNetworkPreservation"] = {"status": "PASS"}
            except (OSError, VerificationError, subprocess.SubprocessError, ValueError):
                errors.append("HOST_PRESERVATION_NOT_CONFIRMED")
                self.report["checks"]["hostNetworkPreservation"] = {"status": "FAIL"}
        self.report["cleanup"]["status"] = "PASS" if not errors else "FAIL"
        return not errors


def self_check():
    module = generator()
    keys = {role: base64.b64encode(bytes([i + 1]) * 32).decode() for i, role in enumerate(ROLES)}
    inv = {}
    for role in ROLES:
        peer = "main" if role == "edge" else "edge"
        inv[role] = {"schema": 1, "role": role, "interfaces": ["lo", WAN],
                     "addresses": [{"ifname": WAN, "mtu": 1500, "addr_info": [{"family": "inet", "local": PUBLIC[role], "prefixlen": 30}]}],
                     "routes": [{"dst": "default", "gateway": PUBLIC[peer], "dev": WAN}],
                     "rules": [{"priority": 0, "table": "local"}, {"priority": 32766, "table": "main"}, {"priority": 32767, "table": "default"}],
                     "udpPorts": [], "ephemeralPortRange": [32768, 60999], "reservedPrefixes": [],
                     "tableAliases": {}, "peerPublicRoute": [{"dst": PUBLIC[peer], "dev": WAN, "prefsrc": PUBLIC[role]}], "nftTables": []}
    files, plan = module.build_candidate(spec_for(keys), inv)
    require(plan["allowedTcpDestinationPortsOnMain"] == PORTS, "GENERATOR_ALLOWED_PORTS_CHANGED")
    for role in ROLES:
        mapped = mapped_plan(plan, role, Path("/disposable-fixture"), {k: "/binary/" + k for k in ("ip", "nft", "wg")})
        require(not any("/etc/" in arg for cmd in mapped for arg in cmd), "PATH_REMAP_FAILED")
        require("PrivateKey" not in files[role + "/peer.conf"], "PRIVATE_KEY_IN_GENERATED_FILE")
    for raw, expected in [(b"\x0a\x00\x00\x01", True), (b"\xac\x0f\x00\x01", False),
                          (b"\xac\x10\x00\x01", True), (b"\xac\x1f\x00\x01", True),
                          (b"\xac\x20\x00\x01", False), (b"\xc0\xa8\x00\x01", True),
                          (b"\x5d\xb8\xd8\x21", False)]:
        require(private_ipv4(raw) == expected, "PRIVATE_ADDRESS_DECODER_FAILED")
    ip_header = b"\x45" + b"\x00" * 8 + b"\x11" + b"\x00" * 2 + b"\x5d\xb8\xd8\x21\x0a\xcb\x4d\x02"
    frame = b"\x00" * 12 + b"\x08\x00" + ip_header
    require(ipv4_frame(frame) == (b"\x5d\xb8\xd8\x21", b"\x0a\xcb\x4d\x02", 17), "FRAME_DECODER_FAILED")
    require(ipv4_frame(frame[:16]) is None, "TRUNCATED_FRAME_ACCEPTED")
    a = {"nftables": [{"metainfo": {"version": "a"}}, {"rule": {"expr": [{"counter": {"packets": 1, "bytes": 5}}, {"drop": None}]}}]}
    b = {"nftables": [{"metainfo": {"version": "b"}}, {"rule": {"expr": [{"counter": {"packets": 9, "bytes": 50}}, {"drop": None}]}}]}
    require(digest(stable(a, "nft")) == digest(stable(b, "nft")), "COUNTER_NORMALIZATION_FAILED")
    b["nftables"][1]["rule"]["expr"][-1] = {"accept": None}
    require(digest(stable(a, "nft")) != digest(stable(b, "nft")), "RULE_CHANGE_WAS_HIDDEN")
    terminal = {"type": "unreachable", "dst": PRIVATE["main"], "metric": 42760}
    active = {"dst": PRIVATE["main"], "dev": WG, "prefsrc": PRIVATE["edge"], "metric": 10}
    require(not active_edge_route_present([terminal]) and active_edge_route_present([terminal, active]), "RECOVERY_ROUTE_DETECTION_FAILED")
    for changed in [{**active, "dev": WAN}, {**active, "prefsrc": PUBLIC["edge"]},
                    {**active, "gateway": PUBLIC["main"]}, {**active, "dst": "default"},
                    {**active, "metric": 11}]:
        rejected = False
        try:
            active_edge_route_present([terminal, changed])
        except VerificationError:
            rejected = True
        require(rejected, "UNREVIEWED_RECOVERY_ROUTE_ACCEPTED")
    emit({"ok": True, "status": "SELF_CHECK_OK_RUNTIME_PENDING", "networkChanges": False,
          "keysCreated": False, "namespaceAcceptance": "PENDING", "liveTunnelAccepted": False})


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise VerificationError("INVALID_ARGUMENTS")


def main():
    parser = SafeParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--output")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--_helper", choices=("capture", "echo", "probe", "control"), help=argparse.SUPPRESS)
    for name in ("host-inode", "namespace-inode", "port"):
        parser.add_argument("--" + name, type=int, help=argparse.SUPPRESS)
    parser.add_argument("--duration", type=float, default=5, help=argparse.SUPPRESS)
    parser.add_argument("--source", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args._helper:
        require(not args.run and not args.self_check and 0 < args.duration <= 120, "INVALID_HELPER_ARGUMENTS")
        return {"capture": capture_helper, "echo": echo_helper, "probe": probe_helper, "control": control_helper}[args._helper](args)
    require(args.run != args.self_check, "SELECT_RUN_OR_SELF_CHECK")
    if args.self_check:
        return self_check()
    require(args.output and 60 <= args.timeout <= 120, "ABSOLUTE_NEW_OUTPUT_AND_BOUNDED_TIMEOUT_REQUIRED")
    output = Path(args.output)
    require(output.is_absolute() and output.parent.is_dir() and output.parent.resolve() == output.parent,
            "CANONICAL_EXISTING_OUTPUT_PARENT_REQUIRED")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    harness = Harness(output, args.timeout)
    previous = {}

    def interrupted(signum, _frame):
        raise VerificationError("INTERRUPTED_OR_DEADLINE_EXCEEDED")

    try:
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
            previous[sig] = signal.signal(sig, interrupted)
        signal.setitimer(signal.ITIMER_REAL, args.timeout - 25)
        try:
            harness.exercise()
            harness.report["status"] = "PASS"
        except (VerificationError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            harness.report["status"] = "UNAVAILABLE" if isinstance(error, VerificationError) and error.unavailable else "FAIL"
            harness.report["failure"] = {"code": error.code if isinstance(error, VerificationError) else "HARNESS_OPERATION_FAILED",
                                         "returncode": getattr(error, "returncode", None)}
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            if not harness.cleanup():
                harness.report["status"] = "FAIL"
        harness.report["elapsedSeconds"] = round(time.monotonic() - harness.started, 3)
        harness.report["isolatedIpv4ConfinementAccepted"] = harness.report["status"] == "PASS"
        with os.fdopen(fd, "w") as out:
            json.dump(harness.report, out, indent=2)
            out.write("\n")
        emit({"ok": harness.report["status"] == "PASS", "status": harness.report["status"],
              "receipt": str(output), "liveTunnelAccepted": False, "public443Accepted": False,
              "failure": harness.report.get("failure")})
        return 0 if harness.report["status"] == "PASS" else 1
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except (VerificationError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        emit({"ok": False, "code": error.code if isinstance(error, VerificationError) else "VERIFICATION_FAILED",
              "liveTunnelAccepted": False})
        sys.exit(1)
