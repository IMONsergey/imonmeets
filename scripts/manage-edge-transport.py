#!/usr/bin/env python3
"""Explicit privileged lifecycle for the reviewed IMON host-pair transport.

Not a general installer. Never changes UFW, packages, keys, defaults, DNS or NAT.
Stopping removes only an owned WireGuard link, leaving all fail-closed guards.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import uuid

loader = importlib.util.spec_from_file_location("transport_candidate", Path(__file__).with_name("prepare-edge-transport.py"))
candidate = importlib.util.module_from_spec(loader)
loader.loader.exec_module(candidate)
Error = candidate.CandidateError
require = candidate.require
IP = "/usr/bin/ip"
WG = "/usr/bin/wg"
NFT = "/usr/sbin/nft"


def run(argv, *, input_bytes=None):
    # Never interpolate commands, print subprocess output, or put keys in argv.
    result = subprocess.run(argv, input=input_bytes, capture_output=True, timeout=15)
    require(result.returncode == 0, "SCOPED_COMMAND_FAILED")
    return result.stdout


def data(argv):
    return json.loads(run(argv))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def secure_path(path, directory=False):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode), "SYMLINK_FORBIDDEN")
    require(info.st_uid == 0 and info.st_mode & 0o077 == 0, "PRIVATE_ROOT_OWNERSHIP_REQUIRED")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "INVALID_FILE_TYPE")
    if not directory:
        require(info.st_size <= 262144, "CONFIG_TOO_LARGE")


def save(path, value):
    temp = path.with_name(path.name + ".new-" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_owned(path):
    secure_path(path)
    return json.loads(path.read_bytes())


def nft_digest():
    entries = data([NFT, "--json", "list", "table", "inet", candidate.TABLE])["nftables"]
    # Handles are kernel allocation details. No counters or timeouts are used.
    def clean(value):
        if isinstance(value, list):
            return [clean(v) for v in value if not (isinstance(v, dict) and "metainfo" in v)]
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if k not in {"handle", "index"}}
        return value
    return digest(json.dumps(clean(entries), sort_keys=True, separators=(",", ":")).encode())


def host_prefix(value):
    try:
        return str(ipaddress.IPv4Network(value, strict=False))
    except (ValueError, TypeError):
        return None


class Lifecycle:
    def __init__(self, config):
        require(os.geteuid() == 0, "ROOT_REQUIRED")
        secure_path(config.parent, directory=True)
        manifest = load_owned(config)
        require(set(manifest) == {"schema", "role", "spec", "reservedPrefixes", "files"} and manifest["schema"] == 1, "INVALID_RUNTIME_MANIFEST")
        self.spec = manifest["spec"]
        candidate.validate_spec(self.spec)
        self.role = manifest["role"]
        require(self.role in {"edge", "main"}, "INVALID_ROLE")
        self.iface = self.spec["interface"]
        self.base = Path("/etc/imonmeets/transport") / self.iface
        require(config == self.base / "runtime.json", "FIXED_CONFIG_PATH_REQUIRED")
        self.local = self.spec[self.role]
        self.peer = self.spec["main" if self.role == "edge" else "edge"]
        self.prefix = self.peer["tunnelIp"] + "/32"
        self.table = str(self.spec["routeTable"])
        self.priority = str(self.spec["rulePriority"])
        self.reserved = manifest["reservedPrefixes"]
        require(isinstance(self.reserved, list), "INVALID_RESERVED_PREFIXES")
        require(set(manifest["files"]) == {"guard.nft", "peer.conf"}, "INVALID_FILE_MANIFEST")
        for name, expected in manifest["files"].items():
            path = self.base / name
            secure_path(path)
            require(digest(path.read_bytes()) == expected, "CONFIG_HASH_MISMATCH")
        require((self.base / "guard.nft").read_text() == candidate.guard(self.role, self.local, self.peer, self.iface), "GUARD_SPEC_MISMATCH")
        require((self.base / "peer.conf").read_text() == candidate.peer_config(self.local, self.peer), "PEER_SPEC_MISMATCH")
        self.config_hash = digest(config.read_bytes())
        self.state = Path("/run/imonmeets-transport-" + self.iface)
        self.state.mkdir(mode=0o700, exist_ok=True)
        secure_path(self.state, directory=True)
        self.guard_journal = self.state / "guard.json"
        self.link_journal = self.state / "link.json"
        self.lock = os.open(self.state / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def link(self):
        links = data([IP, "-j", "-d", "link", "show"])
        return next((v for v in links if v.get("ifname") == self.iface), None)

    def verify_guard(self):
        journal = load_owned(self.guard_journal)
        require(journal.get("phase") == "ready" and journal.get("configHash") == self.config_hash, "GUARD_NOT_OWNED_OR_INCOMPLETE")
        require(nft_digest() == journal.get("nftHash"), "GUARD_CHANGED")
        routes = data([IP, "-4", "-j", "route", "show", "table", self.table])
        unreachable = [r for r in routes if r.get("type") == "unreachable" and host_prefix(r.get("dst")) == self.prefix and r.get("metric") == 42760]
        require(len(unreachable) == 1, "TERMINAL_ROUTE_MISSING")
        for route in routes:
            require(route in unreachable or (host_prefix(route.get("dst")) == self.prefix and route.get("dev") == self.iface and route.get("prefsrc", route.get("src")) == self.local["tunnelIp"] and route.get("metric") == 10), "ROUTING_TABLE_CHANGED")
        rules = [r for r in data([IP, "-4", "-j", "rule", "show"]) if r.get("priority") == int(self.priority)]
        require(len(rules) == 1, "PEER_RULE_MISSING_OR_AMBIGUOUS")
        rule = rules[0]
        require(host_prefix(rule.get("dst")) == self.prefix and str(rule.get("table")) == self.table and rule.get("src", "all") == "all" and not any(key in rule for key in ["fwmark", "iif", "oif", "not"]), "PEER_RULE_CHANGED")
        return journal

    def guard_start(self):
        if self.guard_journal.exists():
            self.verify_guard()
            return
        inv = candidate.capture_inventory(self.role, self.peer["publicIp"])
        inv["reservedPrefixes"] = self.reserved
        candidate.validate_inventory(self.role, self.local, self.peer, inv, self.spec)
        require(inv["nftTables"] is not None and inv["wireguardToolAvailable"], "PRIVILEGED_PREFLIGHT_INCOMPLETE")
        run([NFT, "--check", "--file", str(self.base / "guard.nft")])
        journal = {"phase": "installing", "configHash": self.config_hash}
        save(self.guard_journal, journal)
        # Failure intentionally leaves the installed guards. No network rollback
        # runs automatically and no foreign named object is ever deleted.
        run([NFT, "--file", str(self.base / "guard.nft")])
        journal["nftHash"] = nft_digest()
        save(self.guard_journal, journal)
        run([IP, "-4", "route", "add", "unreachable", self.prefix, "table", self.table, "metric", "42760"])
        run([IP, "-4", "rule", "add", "priority", self.priority, "to", self.prefix, "lookup", self.table])
        journal["phase"] = "ready"
        save(self.guard_journal, journal)
        self.verify_guard()

    def link_start(self):
        self.verify_guard()
        require(self.link() is None and not self.link_journal.exists(), "LINK_OR_JOURNAL_EXISTS")
        key_path = self.base / "private.key"
        secure_path(key_path)
        # Check the public half without printing the secret or subprocess output.
        with key_path.open("rb") as key:
            public = subprocess.run([WG, "pubkey"], stdin=key, capture_output=True, timeout=10)
        require(public.returncode == 0 and public.stdout.decode().strip() == self.local["publicKey"], "PRIVATE_KEY_PAIR_MISMATCH")
        token = "imon-meets-owned:" + uuid.uuid4().hex
        journal = {"configHash": self.config_hash, "alias": token, "ifindex": None}
        save(self.link_journal, journal)
        try:
            run([IP, "link", "add", "dev", self.iface, "type", "wireguard"])
            run([IP, "link", "set", "dev", self.iface, "alias", token])
            current = self.link()
            require(current and current.get("ifalias") == token, "LINK_OWNERSHIP_NOT_RECORDED")
            journal["ifindex"] = current["ifindex"]
            save(self.link_journal, journal)
            run([WG, "setconf", self.iface, str(self.base / "peer.conf")])
            run([WG, "set", self.iface, "private-key", str(key_path)])
            run([IP, "address", "add", self.local["tunnelIp"] + "/32", "dev", self.iface])
            run([IP, "link", "set", "dev", self.iface, "mtu", str(self.spec["mtu"]), "up"])
            run([IP, "-4", "route", "add", self.prefix, "dev", self.iface, "src", self.local["tunnelIp"], "table", self.table, "metric", "10"])
            self.verify_guard()
        except BaseException:
            # Delete only when both an alias and the current kernel ifindex prove
            # ownership. An interrupted pre-alias creation requires manual review.
            try:
                self.link_stop()
            except (Error, OSError, ValueError, subprocess.SubprocessError):
                pass
            raise

    def link_stop(self):
        current = self.link()
        if not self.link_journal.exists():
            require(current is None, "LINK_WITHOUT_OWNERSHIP_JOURNAL")
            return
        journal = load_owned(self.link_journal)
        require(journal.get("configHash") == self.config_hash, "LINK_CONFIG_CHANGED")
        if current is not None:
            require(journal.get("ifindex") is not None and current.get("ifindex") == journal["ifindex"] and current.get("ifalias") == journal.get("alias") and current.get("linkinfo", {}).get("info_kind") == "wireguard", "LINK_OWNERSHIP_MISMATCH")
            run([IP, "link", "delete", "dev", self.iface])
        self.link_journal.unlink()
        # Keep nft table, rule and unreachable route even when link creation failed.


def main():
    parser = candidate.SafeParser(description=__doc__)
    parser.add_argument("action", choices=["guard-start", "guard-check", "link-start", "link-stop"])
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    life = Lifecycle(Path(args.config))
    getattr(life, args.action.replace("-", "_") if args.action != "guard-check" else "verify_guard")()
    print(json.dumps({"ok": True, "action": args.action, "guardsRetained": True, "confinementAccepted": False}))


if __name__ == "__main__":
    try:
        main()
    except (Error, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "code": str(error) if isinstance(error, Error) else "SCOPED_LIFECYCLE_FAILED", "automaticGuardRemoval": False}), file=sys.stderr)
        sys.exit(1)
