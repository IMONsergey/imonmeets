#!/usr/bin/env python3
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name("prepare-edge-transport.py")
loader = importlib.util.spec_from_file_location("edge_transport_candidate", SCRIPT)
module = importlib.util.module_from_spec(loader)
loader.loader.exec_module(module)


def fixture():
    spec = {"schema": 1, "interface": "wg-meets", "routeTable": 51843, "rulePriority": 11000, "mtu": 1380}
    inventories = {}
    for index, role in enumerate(["edge", "main"], start=1):
        public = "93.184.216." + str(index + 33)
        peer = "93.184.216." + str(36 - index)
        spec[role] = {"publicIp": public, "tunnelIp": "10.203.77." + str(index),
                      "publicKey": base64.b64encode(bytes([index]) * 32).decode(),
                      "listenPort": 21843, "wanInterface": "eth0"}
        inventories[role] = {
            "schema": 1, "role": role, "interfaces": ["lo", "eth0", "docker0"],
            "addresses": [{"ifname": "eth0", "mtu": 1500, "addr_info": [{"family": "inet", "local": public, "prefixlen": 24}]},
                          {"ifname": "docker0", "mtu": 1500, "addr_info": [{"family": "inet", "local": "172.17.0.1", "prefixlen": 16}]}],
            "routes": [{"dst": "default", "gateway": "93.184.216.1", "dev": "eth0"}, {"dst": "172.17.0.0/16", "dev": "docker0"}],
            "rules": [{"priority": 0, "table": "local"}, {"priority": 32766, "table": "main"}, {"priority": 32767, "table": "default"}],
            "udpPorts": [53], "ephemeralPortRange": [32768, 60999], "reservedPrefixes": [], "tableAliases": {"local": 255, "main": 254, "default": 253},
            "peerPublicRoute": [{"dst": peer, "gateway": "93.184.216.1", "dev": "eth0", "prefsrc": public}],
            "nftTables": [], "nestedNamespacePrefixesReviewed": False,
        }
    return spec, inventories


class TransportCandidateTests(unittest.TestCase):
    def rejected(self, spec, inventories, code):
        with self.assertRaisesRegex(module.CandidateError, "^" + code + "$"):
            module.build_candidate(spec, inventories)

    def test_transport_has_only_one_peer_and_no_secret_or_default_route(self):
        spec, inv = fixture()
        files, plan = module.build_candidate(spec, inv)
        self.assertEqual(set(files), {role + "/" + name for role in ["edge", "main"] for name in ["guard.nft", "peer.conf", "runtime.json", "imon-meets-transport-guard.service", "imon-meets-transport.service", "ingress-dependency.conf"]})
        for role, peer in [("edge", "main"), ("main", "edge")]:
            cfg = files[role + "/peer.conf"]
            self.assertEqual(cfg.count("[Peer]"), 1)
            self.assertIn("AllowedIPs = " + spec[peer]["tunnelIp"] + "/32\n", cfg)
            self.assertIn("Endpoint = " + spec[peer]["publicIp"] + ":21843\n", cfg)
            for forbidden in ["PrivateKey", "0.0.0.0/0", "::/0", "DNS", "SaveConfig", "PostUp", "PostDown"]:
                self.assertNotIn(forbidden, cfg)
        for key in ["productionChanges", "keysCreated", "networkChanges", "tunnelConfigured", "nftSyntaxAccepted", "kernelConfinementAccepted", "public443Accepted", "automaticInstallerIncluded"]:
            self.assertIs(plan[key], False)
        self.assertTrue(plan["persistentBootUnitsIncluded"])
        self.assertTrue(plan["scopedLifecycleRunnerIncluded"])

    def test_directional_guard_checks_full_tuples_interfaces_and_drops_forward(self):
        spec, inv = fixture()
        files, _ = module.build_candidate(spec, inv)
        edge, main = files["edge/guard.nft"], files["main/guard.nft"]
        self.assertIn('iifname "eth0" ip saddr 93.184.216.35 ip daddr 93.184.216.34 udp sport 21843 udp dport 21843 accept', edge)
        self.assertIn('oifname "wg-meets" ip saddr 10.203.77.1 ip daddr 10.203.77.2 tcp dport { 5349, 8445, 18080 } ct state { new, established } accept', edge)
        self.assertIn('iifname "wg-meets" ip saddr 10.203.77.2 ip daddr 10.203.77.1 tcp sport { 5349, 8445, 18080 } ct state established accept', edge)
        self.assertIn('iifname "wg-meets" ip saddr 10.203.77.1 ip daddr 10.203.77.2 tcp dport { 5349, 8445, 18080 } ct state { new, established } accept', main)
        for guard in [edge, main]:
            self.assertIn('udp dport 21843 drop', guard)
            self.assertIn('udp sport 21843 drop', guard)
            self.assertIn('iifname "wg-meets" drop', guard)
            self.assertIn('oifname "wg-meets" drop', guard)
            self.assertIn('type filter hook forward priority -25; policy accept;', guard)
            for forbidden in ["flush ruleset", "masquerade", "dnat", "snat", "hook prerouting", "hook postrouting"]:
                self.assertNotIn(forbidden, "\n".join(x for x in guard.splitlines() if not x.startswith("#")))

    def test_terminal_route_installed_before_peer_rule_and_interface(self):
        spec, inv = fixture()
        _, plan = module.build_candidate(spec, inv)
        for role, peer in [("edge", "main"), ("main", "edge")]:
            p = plan["hostPlans"][role]
            commands = p["guardThenRouteThenInterface"]
            self.assertEqual(commands[2], ["/usr/bin/ip", "-4", "route", "add", "unreachable", spec[peer]["tunnelIp"] + "/32", "table", "51843", "metric", "42760"])
            self.assertEqual(commands[3][4:8], ["priority", "11000", "to", spec[peer]["tunnelIp"] + "/32"])
            self.assertIn("wireguard", commands[4])
            self.assertEqual(commands[-1][-2:], ["metric", "10"])
            self.assertEqual(p["stopOnlyOwnedInterfaceAfterStoppingIngress"], ["/usr/bin/ip", "link", "delete", "dev", "wg-meets"])
            self.assertTrue(p["guardMustRemainWhenTunnelStops"])

    def test_rejects_public_or_noncanonical_tunnel_addresses(self):
        for address in ["127.0.0.1", "100.64.0.1", "169.254.3.1", "93.184.216.1", "010.1.1.1", "10.1.1.1/32", "10.1.1.1\nPostUp=evil"]:
            with self.subTest(address=address):
                spec, inv = fixture(); spec["edge"]["tunnelIp"] = address
                with self.assertRaises(module.CandidateError): module.build_candidate(spec, inv)

    def test_rejects_injection_and_unknown_secret_fields(self):
        for field, value in [("interface", "wg-x\nflush ruleset"), ("interface", "eth0"), ("rulePriority", True), ("routeTable", 254), ("mtu", 1450)]:
            with self.subTest(field=field):
                spec, inv = fixture(); spec[field] = value
                with self.assertRaises(module.CandidateError): module.build_candidate(spec, inv)
        spec, inv = fixture(); spec["edge"]["privateKey"] = "never-print-secret"
        self.rejected(spec, inv, "INVALID_HOST_FIELDS")
        spec, inv = fixture(); spec["edge"]["wanInterface"] = "eth0; evil"
        self.rejected(spec, inv, "INVALID_WAN_INTERFACE")

    def test_rejects_invalid_or_duplicate_peer_public_keys(self):
        for key in ["A" * 42, base64.b64encode(bytes(32)).decode(), "B" * 44, "A" * 43 + "=\n"]:
            spec, inv = fixture(); spec["main"]["publicKey"] = key
            self.rejected(spec, inv, "INVALID_PUBLIC_KEY")
        spec, inv = fixture(); spec["main"]["publicKey"] = spec["edge"]["publicKey"]
        self.rejected(spec, inv, "PEER_COLLISION")

    def test_rejects_private_public_or_unassigned_endpoint(self):
        spec, inv = fixture(); spec["edge"]["publicIp"] = "192.168.1.1"
        self.rejected(spec, inv, "INVALID_ADDRESS_CLASS")
        spec, inv = fixture(); spec["edge"]["publicIp"] = "93.184.216.38"
        self.rejected(spec, inv, "PUBLIC_IP_NOT_ASSIGNED")

    def test_two_host_pair_rejects_network_broadcast_different_subnets(self):
        for value in ["10.203.77.0", "10.203.77.3", "10.203.78.2"]:
            spec, inv = fixture(); spec["main"]["tunnelIp"] = value
            self.rejected(spec, inv, "TWO_HOST_SUBNET_REQUIRED")

    def test_collision_detected_in_either_hosts_routes_or_reserved_namespace(self):
        for role in ["edge", "main"]:
            spec, inv = fixture(); inv[role]["routes"].append({"dst": "10.0.0.0/8"})
            self.rejected(spec, inv, "TUNNEL_ADDRESS_COLLISION")
            spec, inv = fixture(); inv[role]["reservedPrefixes"].append("10.203.77.0/30")
            self.rejected(spec, inv, "TUNNEL_ADDRESS_COLLISION")

    def test_existing_ipv6_only_interface_and_udp_port_are_rejected(self):
        spec, inv = fixture(); inv["main"]["interfaces"].append("wg-meets")
        self.rejected(spec, inv, "INTERFACE_EXISTS")
        spec, inv = fixture(); inv["edge"]["udpPorts"].append(21843)
        self.rejected(spec, inv, "UDP_PORT_IN_USE")

    def test_rejects_listen_port_inside_ephemeral_range_on_either_host(self):
        for role in ["edge", "main"]:
            spec, inv = fixture(); spec[role]["listenPort"] = 51843
            self.rejected(spec, inv, "LISTEN_PORT_INSIDE_EPHEMERAL_RANGE")
            spec, inv = fixture(); inv[role]["ephemeralPortRange"] = [20000, 30000]
            self.rejected(spec, inv, "LISTEN_PORT_INSIDE_EPHEMERAL_RANGE")

    def test_udp_inventory_includes_connected_sockets(self):
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, "ESTAB 0 0 93.184.216.34:21843 93.184.216.35:9999\nUNCONN 0 0 127.0.0.53:53 0.0.0.0:*\n")
        def fake_json(argv):
            if "link" in argv: return [{"ifname": "eth0"}]
            return []
        with mock.patch.object(module.subprocess, "run", side_effect=fake_run), mock.patch.object(module, "run_json", side_effect=fake_json), mock.patch.object(Path, "is_file", return_value=False), mock.patch.object(Path, "read_text", return_value="32768 60999"):
            inv = module.capture_inventory("edge", "93.184.216.35")
        self.assertIn(["ss", "-H", "-uan"], calls)
        self.assertEqual(inv["udpPorts"], [53, 21843])
        self.assertEqual(inv["ephemeralPortRange"], [32768, 60999])

    def test_systemd_guard_order_and_stop_keep_guard(self):
        spec, inv = fixture()
        files, _ = module.build_candidate(spec, inv)
        for role in ["edge", "main"]:
            guard = files[role + "/imon-meets-transport-guard.service"]
            link = files[role + "/imon-meets-transport.service"]
            ingress = files[role + "/ingress-dependency.conf"]
            self.assertIn("After=network-online.target nftables.service ufw.service", guard)
            self.assertIn("RuntimeDirectoryPreserve=yes", guard)
            self.assertNotIn("ExecStop", guard)
            self.assertIn("Requires=imon-meets-transport-guard.service", link)
            self.assertIn("After=imon-meets-transport-guard.service", link)
            self.assertIn("link-stop --config", link)
            self.assertIn("BindsTo=imon-meets-transport.service", ingress)

    def test_route_table_alias_and_rule_conflicts_are_rejected(self):
        spec, inv = fixture(); inv["main"]["tableAliases"]["other"] = 51843; inv["main"]["rules"].append({"priority": 32765, "table": "other"})
        self.rejected(spec, inv, "ROUTING_TABLE_IN_USE")
        spec, inv = fixture(); inv["main"]["rules"].append({"priority": 11000, "table": 65743})
        self.rejected(spec, inv, "RULE_PRIORITY_IN_USE")
        spec, inv = fixture(); inv["main"]["rules"].append({"priority": 9999, "table": 65743})
        self.rejected(spec, inv, "EARLIER_POLICY_RULE_REQUIRES_REVIEW")

    def test_underlay_mismatch_and_mtu_are_rejected(self):
        for key, value in [("dev", "tun0"), ("prefsrc", "10.0.0.1"), ("dst", "93.184.216.99"), ("type", "unreachable")]:
            spec, inv = fixture(); inv["edge"]["peerPublicRoute"][0][key] = value
            with self.assertRaises(module.CandidateError): module.build_candidate(spec, inv)
        spec, inv = fixture(); inv["edge"]["addresses"][0]["mtu"] = 1400
        self.rejected(spec, inv, "MTU_EXCEEDS_UNDERLAY")

    def test_absent_nft_privilege_never_claims_table_review(self):
        spec, inv = fixture(); inv["main"]["nftTables"] = None
        _, plan = module.build_candidate(spec, inv)
        self.assertFalse(plan["hostPlans"]["main"]["nftTableAbsenceVerified"])
        inv["main"]["nftTables"] = [{"family": "inet", "name": "imon_meets_transport"}]
        self.rejected(spec, inv, "GUARD_TABLE_EXISTS")

    def test_private_output_and_overwrite_refusal(self):
        spec, inv = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "spec.json").write_text(json.dumps(spec))
            for role in ["edge", "main"]: (root / (role + ".json")).write_text(json.dumps(inv[role]))
            target = root / "candidate"
            args = [sys_executable(), str(SCRIPT), "generate", "--spec", str(root / "spec.json"), "--main-inventory", str(root / "main.json"), "--edge-inventory", str(root / "edge.json"), "--output", str(target)]
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o700)
            for path in target.rglob("*"):
                self.assertEqual(os.stat(path).st_mode & 0o777, 0o700 if path.is_dir() else 0o600)
            before = (target / "plan.json").read_bytes()
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((target / "plan.json").read_bytes(), before)
            self.assertNotIn(str(target), result.stderr)

    def test_unknown_cli_argument_does_not_echo_value(self):
        secret = "never-print-secret"
        result = subprocess.run([sys_executable(), str(SCRIPT), secret], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(secret, result.stdout + result.stderr)


def sys_executable():
    import sys
    return sys.executable


if __name__ == "__main__":
    unittest.main()
