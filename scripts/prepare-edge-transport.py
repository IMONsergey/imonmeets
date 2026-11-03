#!/usr/bin/env python3
"""Read-only inventory and private WireGuard transport candidate generation.

Never installs packages, creates keys, or executes the generated network plan.
"""
import argparse
import base64
import datetime as dt
import hashlib
import ipaddress as ip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


TABLE = "imon_meets_transport"
PORTS = [5349, 8445, 18080]
ROLE_FIELDS = {"publicIp", "tunnelIp", "publicKey", "listenPort", "wanInterface"}
SPEC_FIELDS = {"schema", "interface", "routeTable", "rulePriority", "mtu", "edge", "main"}


class CandidateError(ValueError):
    pass


def require(ok, code):
    if not ok:
        raise CandidateError(code)


def address(value, private=False):
    require(isinstance(value, str), "INVALID_IPV4")
    try:
        parsed = ip.IPv4Address(value)
    except ValueError:
        raise CandidateError("INVALID_IPV4") from None
    require(str(parsed) == value, "NONCANONICAL_IPV4")
    rfc1918 = any(parsed in ip.IPv4Network(n) for n in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"])
    require(rfc1918 if private else parsed.is_global and not parsed.is_multicast, "INVALID_ADDRESS_CLASS")
    return parsed


def integer(value, lo, hi, code):
    require(type(value) is int and lo <= value <= hi, code)
    return value


def public_key(value):
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise CandidateError("INVALID_PUBLIC_KEY") from None
    require(len(raw) == 32 and any(raw) and base64.b64encode(raw).decode() == value, "INVALID_PUBLIC_KEY")


def table_number(value, aliases):
    if value is None:
        return 254
    if str(value).isdigit():
        return int(value)
    require(value in aliases, "UNKNOWN_ROUTING_TABLE_ALIAS")
    return aliases[value]


def validate_inventory(role, host, peer, inv, spec):
    require(isinstance(inv, dict) and inv.get("schema") == 1 and inv.get("role") == role, "INVALID_INVENTORY")
    for field in ["interfaces", "addresses", "routes", "rules", "udpPorts", "ephemeralPortRange", "reservedPrefixes"]:
        require(isinstance(inv.get(field), list), "INCOMPLETE_INVENTORY")
    require(isinstance(inv.get("tableAliases"), dict), "INCOMPLETE_INVENTORY")
    require(all(type(x) is int and 0 < x <= 65535 for x in inv["udpPorts"]), "INVALID_UDP_INVENTORY")
    ephemeral = inv["ephemeralPortRange"]
    require(len(ephemeral) == 2 and all(type(x) is int and 0 < x <= 65535 for x in ephemeral) and ephemeral[0] <= ephemeral[1], "INVALID_EPHEMERAL_RANGE")
    require(not ephemeral[0] <= host["listenPort"] <= ephemeral[1], "LISTEN_PORT_INSIDE_EPHEMERAL_RANGE")
    aliases = {"local": 255, "main": 254, "default": 253, **inv["tableAliases"]}
    require(all(type(x) is int for x in aliases.values()), "INVALID_TABLE_ALIASES")
    require(all(isinstance(name, str) for name in inv["interfaces"]), "INVALID_INTERFACE_INVENTORY")
    require(spec["interface"] not in inv["interfaces"], "INTERFACE_EXISTS")
    wan = [a for a in inv["addresses"] if a.get("ifname") == host["wanInterface"]]
    require(len(wan) == 1, "WAN_INTERFACE_NOT_FOUND")
    require(any(a.get("family") == "inet" and a.get("local") == host["publicIp"] for a in wan[0].get("addr_info", [])), "PUBLIC_IP_NOT_ASSIGNED")
    require(type(wan[0].get("mtu")) is int and spec["mtu"] <= wan[0]["mtu"] - 80, "MTU_EXCEEDS_UNDERLAY")
    require(host["listenPort"] not in inv["udpPorts"], "UDP_PORT_IN_USE")
    used = {table_number(r.get("table"), aliases) for r in inv["routes"] + inv["rules"] if "table" in r}
    require(spec["routeTable"] not in used, "ROUTING_TABLE_IN_USE")
    priorities = [r.get("priority") for r in inv["rules"]]
    require(all(type(p) is int for p in priorities), "INVALID_RULE_PRIORITY")
    require(spec["rulePriority"] not in priorities, "RULE_PRIORITY_IN_USE")
    require(all(p == 0 or spec["rulePriority"] < p for p in priorities), "EARLIER_POLICY_RULE_REQUIRES_REVIEW")
    prefixes = list(inv["reservedPrefixes"])
    for a in inv["addresses"]:
        for v in a.get("addr_info", []):
            if v.get("family") == "inet":
                prefixes.append(str(v["local"]) + "/" + str(v["prefixlen"]))
    for r in inv["routes"]:
        if r.get("dst") not in [None, "default", "0.0.0.0/0"]:
            prefixes.append(r["dst"])
    for prefix in prefixes:
        try:
            network = ip.IPv4Network(prefix, strict=False)
        except ValueError:
            raise CandidateError("INVALID_INVENTORY_PREFIX") from None
        require(network.prefixlen > 0, "DEFAULT_RESERVED_PREFIX_FORBIDDEN")
        require(not any(address(h["tunnelIp"], True) in network for h in [host, peer]), "TUNNEL_ADDRESS_COLLISION")
    route = inv.get("peerPublicRoute")
    require(isinstance(route, list) and len(route) == 1, "MISSING_PEER_UNDERLAY_ROUTE")
    r = route[0]
    require(r.get("dst") == peer["publicIp"] and r.get("dev") == host["wanInterface"] and r.get("prefsrc", r.get("src")) == host["publicIp"], "PEER_UNDERLAY_ROUTE_MISMATCH")
    require(not r.get("type") or r["type"] == "unicast", "PEER_UNDERLAY_ROUTE_UNUSABLE")
    require(isinstance(inv.get("nftTables"), list) or inv.get("nftTables") is None, "INVALID_NFT_INVENTORY")
    if inv.get("nftTables") is not None:
        require(not any(t.get("family") == "inet" and t.get("name") == TABLE for t in inv["nftTables"]), "GUARD_TABLE_EXISTS")


def guard(role, local, peer, interface):
    receive_port = "dport" if role == "main" else "sport"
    send_port = "dport" if role == "edge" else "sport"
    receive_state = "{ new, established }" if role == "main" else "established"
    send_state = "{ new, established }" if role == "edge" else "established"
    return f'''# Candidate only. This owns one dedicated table; never flush the ruleset.
table inet {TABLE} {{
  chain input {{
    type filter hook input priority -25; policy accept;
    iifname "{local['wanInterface']}" ip saddr {peer['publicIp']} ip daddr {local['publicIp']} udp sport {peer['listenPort']} udp dport {local['listenPort']} accept
    udp dport {local['listenPort']} drop
    ip daddr {local['tunnelIp']} iifname != "{interface}" drop
    ip saddr {peer['tunnelIp']} iifname != "{interface}" drop
    iifname "{interface}" ip saddr {peer['tunnelIp']} ip daddr {local['tunnelIp']} tcp {receive_port} {{ 5349, 8445, 18080 }} ct state {receive_state} accept
    iifname "{interface}" drop
  }}
  chain output {{
    type filter hook output priority -25; policy accept;
    oifname "{local['wanInterface']}" ip saddr {local['publicIp']} ip daddr {peer['publicIp']} udp sport {local['listenPort']} udp dport {peer['listenPort']} accept
    udp sport {local['listenPort']} drop
    oifname "{interface}" ip saddr {local['tunnelIp']} ip daddr {peer['tunnelIp']} tcp {send_port} {{ 5349, 8445, 18080 }} ct state {send_state} accept
    ip saddr {local['tunnelIp']} drop
    ip daddr {peer['tunnelIp']} drop
    oifname "{interface}" drop
  }}
  chain forward {{
    type filter hook forward priority -25; policy accept;
    iifname "{interface}" drop
    oifname "{interface}" drop
    ip saddr {{ {local['tunnelIp']}, {peer['tunnelIp']} }} drop
    ip daddr {{ {local['tunnelIp']}, {peer['tunnelIp']} }} drop
  }}
}}
'''


def validate_spec(spec):
    require(isinstance(spec, dict) and set(spec) == SPEC_FIELDS and type(spec.get("schema")) is int and spec["schema"] == 1, "INVALID_SPEC_FIELDS")
    iface = spec["interface"]
    require(isinstance(iface, str) and re.fullmatch(r"wg-[a-z][a-z0-9-]{0,10}", iface), "INVALID_INTERFACE")
    integer(spec["routeTable"], 10000, 60000, "INVALID_ROUTE_TABLE")
    integer(spec["rulePriority"], 1, 32764, "INVALID_RULE_PRIORITY")
    integer(spec["mtu"], 1280, 1420, "INVALID_MTU")
    for role in ["edge", "main"]:
        h = spec[role]
        require(isinstance(h, dict) and set(h) == ROLE_FIELDS, "INVALID_HOST_FIELDS")
        address(h["publicIp"])
        address(h["tunnelIp"], True)
        public_key(h["publicKey"])
        integer(h["listenPort"], 1024, 65535, "INVALID_LISTEN_PORT")
        require(isinstance(h["wanInterface"], str) and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_.-]{0,14}", h["wanInterface"]), "INVALID_WAN_INTERFACE")
    e, m = spec["edge"], spec["main"]
    require(e["publicIp"] != m["publicIp"] and e["tunnelIp"] != m["tunnelIp"] and e["publicKey"] != m["publicKey"], "PEER_COLLISION")
    network = ip.IPv4Network(e["tunnelIp"] + "/30", strict=False)
    require(set([address(e["tunnelIp"], True), address(m["tunnelIp"], True)]) == set(network.hosts()), "TWO_HOST_SUBNET_REQUIRED")


def boot_units(iface):
    base = "/etc/imonmeets/transport/" + iface
    runner = "/usr/bin/python3 /usr/local/lib/imonmeets/manage-edge-transport.py"
    hardening = """User=root
UMask=0077
NoNewPrivileges=yes
ProtectHome=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectControlGroups=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_NETLINK AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=CAP_NET_ADMIN
"""
    return {
        "imon-meets-transport-guard.service": f"""[Unit]
Description=IMON Meets private transport fail-closed guard
Wants=network-online.target
After=network-online.target nftables.service ufw.service
Before=imon-meets-transport.service

[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=imonmeets-transport-{iface}
RuntimeDirectoryMode=0700
RuntimeDirectoryPreserve=yes
ReadWritePaths=/run/imonmeets-transport-{iface}
ExecStart={runner} guard-start --config {base}/runtime.json
{hardening}
""",
        "imon-meets-transport.service": f"""[Unit]
Description=IMON Meets dedicated WireGuard host pair
Requires=imon-meets-transport-guard.service
BindsTo=imon-meets-transport-guard.service
PartOf=imon-meets-transport-guard.service
After=imon-meets-transport-guard.service

[Service]
Type=oneshot
RemainAfterExit=yes
ReadWritePaths=/run/imonmeets-transport-{iface}
ExecStart={runner} link-start --config {base}/runtime.json
ExecStop={runner} link-stop --config {base}/runtime.json
{hardening}
[Install]
WantedBy=multi-user.target
""",
        "ingress-dependency.conf": """# Install only in the dedicated IMON ingress unit's .d directory.
# Do not attach this to a shared Docker daemon, VPN, or current production unit.
[Unit]
Requires=imon-meets-transport.service
BindsTo=imon-meets-transport.service
After=imon-meets-transport.service
""",
    }


def peer_config(local, peer):
    return f"[Interface]\nListenPort = {local['listenPort']}\n\n[Peer]\nPublicKey = {peer['publicKey']}\nAllowedIPs = {peer['tunnelIp']}/32\nEndpoint = {peer['publicIp']}:{peer['listenPort']}\nPersistentKeepalive = 25\n"


def build_candidate(spec, inventories):
    validate_spec(spec)
    iface = spec["interface"]
    e, m = spec["edge"], spec["main"]
    files, host_plans = {}, {}
    for role, local, peer in [("edge", e, m), ("main", m, e)]:
        validate_inventory(role, local, peer, inventories[role], spec)
        base = "/etc/imonmeets/transport/" + iface
        files[role + "/guard.nft"] = guard(role, local, peer, iface)
        files[role + "/peer.conf"] = peer_config(local, peer)
        runtime = {"schema": 1, "role": role, "spec": spec,
                   "reservedPrefixes": inventories[role]["reservedPrefixes"],
                   "files": {name: hashlib.sha256(files[role + "/" + name].encode()).hexdigest() for name in ["guard.nft", "peer.conf"]}}
        files[role + "/runtime.json"] = json.dumps(runtime, indent=2) + "\n"
        for name, content in boot_units(iface).items():
            files[role + "/" + name] = content
        # This is data for an operator, not an executable installer. Sequential
        # ownership-aware application and rollback must be reviewed on each host.
        host_plans[role] = {
            "privateKeyPath": base + "/private.key",
            "guardMustRemainWhenTunnelStops": True,
            "nftTableAbsenceVerified": inventories[role].get("nftTables") is not None,
            "declaredReservedPrefixes": inventories[role]["reservedPrefixes"],
            "guardThenRouteThenInterface": [
                ["/usr/sbin/nft", "--check", "--file", base + "/guard.nft"],
                ["/usr/sbin/nft", "--file", base + "/guard.nft"],
                ["/usr/bin/ip", "-4", "route", "add", "unreachable", peer["tunnelIp"] + "/32", "table", str(spec["routeTable"]), "metric", "42760"],
                ["/usr/bin/ip", "-4", "rule", "add", "priority", str(spec["rulePriority"]), "to", peer["tunnelIp"] + "/32", "lookup", str(spec["routeTable"])],
                ["/usr/bin/ip", "link", "add", "dev", iface, "type", "wireguard"],
                ["/usr/bin/wg", "setconf", iface, base + "/peer.conf"],
                ["/usr/bin/wg", "set", iface, "private-key", base + "/private.key"],
                ["/usr/bin/ip", "address", "add", local["tunnelIp"] + "/32", "dev", iface],
                ["/usr/bin/ip", "link", "set", "dev", iface, "mtu", str(spec["mtu"]), "up"],
                ["/usr/bin/ip", "-4", "route", "add", peer["tunnelIp"] + "/32", "dev", iface, "src", local["tunnelIp"], "table", str(spec["routeTable"]), "metric", "10"],
            ],
            "stopOnlyOwnedInterfaceAfterStoppingIngress": ["/usr/bin/ip", "link", "delete", "dev", iface],
        }
    hashes = {name: hashlib.sha256(value.encode()).hexdigest() for name, value in files.items()}
    plan = {"schema": 1, "status": "CANDIDATE_NOT_APPLIED", "transport": "wireguard-host-pair", "spec": spec,
            "hostPlans": host_plans, "fileSha256": hashes, "allowedTcpDestinationPortsOnMain": PORTS,
            "productionChanges": False, "keysCreated": False, "networkChanges": False, "tunnelConfigured": False,
            "nftSyntaxAccepted": False, "kernelConfinementAccepted": False, "public443Accepted": False,
            "automaticInstallerIncluded": False, "persistentBootUnitsIncluded": True,
            "scopedLifecycleRunnerIncluded": True,
            "unchangedScope": ["default routes", "DNS", "existing VPN", "NAT", "IP forwarding sysctls", "unrelated firewall tables"]}
    return files, plan


def run_json(args):
    result = subprocess.run(args, check=True, capture_output=True, timeout=10)
    return json.loads(result.stdout)


def capture_inventory(role, peer_public):
    address(peer_public)
    interfaces = [v["ifname"] for v in run_json(["ip", "-j", "link", "show"])]
    addresses = run_json(["ip", "-4", "-j", "address", "show"])
    routes = run_json(["ip", "-4", "-j", "route", "show", "table", "all"])
    rules = run_json(["ip", "-4", "-j", "rule", "show"])
    # All UDP states matter: a connected UDP socket need not appear in -l.
    ports = subprocess.run(["ss", "-H", "-uan"], check=True, capture_output=True, text=True, timeout=10).stdout
    udp = []
    for line in ports.splitlines():
        value = line.split()[3].rsplit(":", 1)[-1]
        require(value.isdigit(), "UNRECOGNIZED_UDP_SOCKET")
        udp.append(int(value))
    aliases = {"local": 255, "main": 254, "default": 253}
    for filename in ["/etc/iproute2/rt_tables", "/usr/lib/iproute2/rt_tables"]:
        p = Path(filename)
        if p.is_file():
            for line in p.read_text().splitlines():
                fields = line.split("#", 1)[0].split()
                if len(fields) == 2 and fields[0].isdigit():
                    aliases[fields[1]] = int(fields[0])
    tables = None
    if Path("/usr/sbin/nft").is_file():
        result = subprocess.run(["/usr/sbin/nft", "--json", "list", "tables"], capture_output=True, timeout=10)
        if result.returncode == 0:
            tables = [x["table"] for x in json.loads(result.stdout).get("nftables", []) if "table" in x]
    return {"schema": 1, "role": role, "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "interfaces": interfaces, "addresses": addresses, "routes": routes, "rules": rules, "udpPorts": sorted(set(udp)),
            "ephemeralPortRange": [int(x) for x in Path("/proc/sys/net/ipv4/ip_local_port_range").read_text().split()],
            "reservedPrefixes": [], "nestedNamespacePrefixesReviewed": False, "tableAliases": aliases,
            "peerPublicRoute": run_json(["ip", "-4", "-j", "route", "get", peer_public]),
            "nftTables": tables, "wireguardToolAvailable": shutil.which("wg") is not None,
            "readOnly": True}


def private_write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as out:
        out.write(text)


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise CandidateError("INVALID_ARGUMENTS")


def main():
    parser = SafeParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    inv = sub.add_parser("inventory")
    inv.add_argument("--role", choices=["edge", "main"], required=True)
    inv.add_argument("--peer-public-ip", required=True)
    inv.add_argument("--output", required=True)
    gen = sub.add_parser("generate")
    gen.add_argument("--spec", required=True)
    gen.add_argument("--main-inventory", required=True)
    gen.add_argument("--edge-inventory", required=True)
    gen.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    require(output.is_absolute(), "ABSOLUTE_OUTPUT_REQUIRED")
    if args.action == "inventory":
        private_write(output, json.dumps(capture_inventory(args.role, args.peer_public_ip), indent=2) + "\n")
        print(json.dumps({"ok": True, "status": "READ_ONLY_INVENTORY_WRITTEN"}))
        return
    spec = json.loads(Path(args.spec).read_text())
    inventories = {role: json.loads(Path(getattr(args, role + "_inventory")).read_text()) for role in ["edge", "main"]}
    files, plan = build_candidate(spec, inventories)
    output.mkdir(mode=0o700)
    try:
        for role in ["edge", "main"]:
            (output / role).mkdir(mode=0o700)
        for name, content in files.items():
            private_write(output / name, content)
        private_write(output / "plan.json", json.dumps(plan, indent=2) + "\n")
    except BaseException:
        shutil.rmtree(output)
        raise
    print(json.dumps({"ok": True, "status": plan["status"], "networkChanges": False, "keysCreated": False}))


if __name__ == "__main__":
    try:
        main()
    except (CandidateError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, CandidateError) else "CANDIDATE_PREPARATION_FAILED"
        print(json.dumps({"ok": False, "code": code}), file=sys.stderr)
        sys.exit(1)
