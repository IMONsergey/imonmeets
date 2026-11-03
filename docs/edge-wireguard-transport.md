# Dedicated edge-to-main transport

Status, 2026-11-03: offline checks and the second disposable namespace run passed.
The two host configurations and unit files are verified, and the dedicated transport
is active with a current mutual WireGuard handshake. Existing routes, firewall
rules, listeners and the current main application health were preserved.
[Sanitized commissioning evidence](../verification/edge-transport-commissioning-20261103.json)
records each phase. Live private TCP and stop-confinement proof, boot persistence,
and public 443 acceptance are still pending. The transport is not enabled at boot. Generating a candidate itself never
installs a package, creates a private key, or changes a network.

The [first sanitized namespace receipt](../verification/edge-transport-netns-attempt1-20261103.json)
records a recovery failure after all three healthy ports had passed. Administrative
link-down removed the explicit active peer route. The
[second sanitized receipt](../verification/edge-transport-netns-attempt2-20261103.json)
records 14 passing checks, including controlled reinstallation of the exact
source-bound peer route, interface deletion and deliberate default-route fallback
with zero private IPv4 leakage. Both runs cleaned up their resources and preserved
the host network. Host inventories, real keys and generated host peer configurations
are omitted from the public receipts. The isolated test and live two-host acceptance
remain separate gates; public DNS and public 443 remain outside this apply step.

## Contract

Use one WireGuard interface, `wg-meets`, for the two dedicated host addresses:

| Setting | Edge | Main |
| --- | --- | --- |
| Private address | `10.203.77.1/32` | `10.203.77.2/32` |
| Peer AllowedIPs | `10.203.77.2/32` | `10.203.77.1/32` |
| UDP listen port | `21843` | `21843` |
| MTU | `1380` | `1380` |
| Route table | `51843` | `51843` |
| Policy rule | priority `11000`, destination peer `/32` only | same |

The generated spec records each actual public address, WAN interface and public
key. It is an operator-owned private artifact, not a repository fixture. Each
host keeps its own private key in `/etc/imonmeets/transport/wg-meets/private.key`.
Only the public halves are exchanged.

Allowed inner traffic is edge-originated TCP to the main address on:

- `8445`: existing TLS bytes and exactly the edge's existing PROXY v2 header;
- `5349`: existing TURN TLS bytes, without a PROXY header;
- `18080`: the separately reviewed HTTP ACME challenge-only endpoint.

The main endpoint layer binds the private main address and checks the edge `/32`.
The transport does not terminate TLS, inject a PROXY header, proxy arbitrary
HTTP paths, or change the application's existing production listeners.

WireGuard preserves the RFC1918 source/destination binding required by those
endpoint and HAProxy contracts. Restricted SSH forwarding is useful for narrow
administration but would terminate and recreate TCP streams, commonly yielding
loopback source addresses. Satisfying this contract through it would need an
additional identity/binding design. A dedicated WireGuard peer pair is smaller
and supports all three explicitly scoped services with the same routing policy.

## Why loss of the tunnel stays closed

The guard owns only `table inet imon_meets_transport`. It does not flush other
tables and does not broadly trust the interface. It permits the exact public
peer UDP tuple and exact private TCP tuple on their observed interfaces. It
drops other input on the WireGuard interface, unrelated UDP on the reserved
listen port, private addresses seen on the wrong interface, and all forwarding
to or from the transport addresses/interface. Existing host IP forwarding may
remain enabled for Docker; this transport cannot act as a router.

Before creating WireGuard, the lifecycle installs an `unreachable peer/32` route
at metric 42760 in table 51843, followed by the destination-only priority 11000
rule. An active WireGuard route at metric 10 overrides that terminal route.
If the interface disappears, the unreachable route remains. The kernel cannot
continue to an existing VPN policy or the normal default route for that peer.
The output guard additionally drops private-source or peer-destination packets
that do not take the allowed WireGuard path, including an unbound client's
attempt after a policy rule is removed.

No default routes, DNS settings, NAT, sysctls, existing VPN interfaces, or
unrelated firewall tables are changed. Port 21843 was selected outside the
observed 32768–60999 ephemeral ranges; an earlier proposal using 51843 for the
**UDP port** was rejected for that reason. The unrelated route table number
51843 is safe to retain if the fresh inventory still finds it unused.

The main's existing rule at priority 32765 and its table are preserved. The new
rule precedes it only for the single private peer destination. The generator
rejects an earlier non-local rule that would require a new routing review.

## Files and checks

`scripts/prepare-edge-transport.py` performs read-only inventory and generates
the private candidate. It checks strict input types, RFC1918 host pair, public
addresses assigned to the selected WAN, public peer route/source, MTU, all UDP
socket states, ephemeral ranges, interface/route/rule/prefix collisions, and
the dedicated nft table's absence when privileged inventory is available.

Host inventory alone does not prove nested VPN/network namespace prefixes are
absent. Review those separately and add any occupied prefixes to the inventory's
`reservedPrefixes`. The `nestedNamespacePrefixesReviewed` field starts false
and is never silently promoted by the generator. The kernel firewall review
must include existing DNAT/REDIRECT and multiport matches: a UDP service can be
published through Docker without a host socket, and nft JSON may represent
iptables extension matches opaquely.

The generator writes a new 0700 output directory and 0600 files, refusing an
existing output path. It emits per-host `guard.nft`, `peer.conf`, `runtime.json`,
two systemd units, and an ingress dependency drop-in. `plan.json` contains file
hashes and the exact guard → route → rule → link command order. All acceptance
flags remain false until separate evidence exists.

The explicit privileged runner `scripts/manage-edge-transport.py` is not an
installer. Its only actions are `guard-start`, `guard-check`, `link-start`, and
`link-stop`. It verifies root-owned private configuration, hashes, exact guard
and peer semantics, a fresh host preflight, and the owned table/rule state.
Errors expose fixed codes rather than configuration or private key material.

The systemd guard starts after existing nftables/UFW services and network-online.
The link requires that guard. A dedicated IMON ingress unit must depend on the
link using the generated drop-in; never attach that dependency to the shared
Docker daemon, existing VPN, or current production service. Guard shutdown has
no deletion command. Its runtime journal remains until reboot; a fresh boot
reconstructs the guard before the link and dependent ingress.

## Prepare without network changes

Run the non-privileged tests:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-edge-transport.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-edge-transport-lifecycle.py
```

Install `wireguard-tools` from the host's official Ubuntu repository only after
reviewing the package simulation. Inventory both hosts with the generator as
root, saving separate private files:

```sh
python3 scripts/prepare-edge-transport.py inventory \
  --role edge --peer-public-ip MAIN_PUBLIC_IP \
  --output /root/imon-transport/edge-inventory.json
```

Use `--role main --peer-public-ip EDGE_PUBLIC_IP` on main. Create the private
parent directories first. The command refuses an existing output file, allowing
old evidence to remain intact.

Before keys or live transport, run the bounded namespace harness on the **new
edge VPS**, whose test load is isolated from the current application/VPN:

```sh
python3 scripts/verify-edge-transport-netns.py --run \
  --timeout 120 \
  --output /var/lib/imonmeets-transport/commissioning-20261103/netns-acceptance.json
```

Create the private receipt parent first and use a new output filename for each run.
The harness creates only its own disposable namespaces and veth pair. It uses
generated guards/routes, ephemeral test keys, no real WAN peers, no host bridge,
and no host default route. It checks healthy service traffic, denied traffic,
the later INPUT DROP case, interface loss and deliberate policy fallback. A
positive-control packet capture must prove the private-IPv4 leak detector works.
Host address/route/rule/firewall snapshots before and after must match after
normalizing counters. The receipt describes only the isolated test and keeps
live, public-443, and IPv6 acceptance false. Review failure receipts before any
retry; do not interpret an unavailable test as passing.

Generate each live host key once, inside its final private directory, only after
the namespace test and live preflight are accepted. Use umask 077 and exclusive
file creation; refuse to overwrite an existing key. Derive the public half with
`wg pubkey` and exchange only that public value. Never include keys in arguments,
logs, a repository, chat, a manifest, a witness receipt, or a Docker build context.
The runner verifies that each private key matches the spec's local public key.

Create a spec with exactly the fields demonstrated by the generator tests:
`schema`, `interface`, `routeTable`, `rulePriority`, `mtu`, and `edge`/`main`
objects with `publicIp`, `tunnelIp`, `publicKey`, `listenPort`, `wanInterface`.
Then generate into a new private output directory:

```sh
python3 scripts/prepare-edge-transport.py generate \
  --spec /root/imon-transport/spec.json \
  --edge-inventory /root/imon-transport/edge-inventory.json \
  --main-inventory /root/imon-transport/main-inventory.json \
  --output /root/imon-transport/candidate
```

Review the plan hashes and exact addresses before staging files.

## Existing firewall integration

On the observed main host UFW owns IPv4 INPUT with policy DROP. An ACCEPT in the
new earlier nft base chain does not override a later chain's DROP. Keep UFW as
the owner of those existing rules. Review read-only `ufw status verbose` and
`iptables-save`, then dry-run the following narrowly scoped additions, replacing
only the two public address placeholders with the verified spec values:

```sh
ufw --dry-run allow in on eth0 proto udp \
  from EDGE_PUBLIC_IP port 21843 to MAIN_PUBLIC_IP port 21843 \
  comment 'imon-meets-transport-underlay'
ufw --dry-run allow in on wg-meets proto tcp \
  from 10.203.77.1 to 10.203.77.2 port 5349,8445,18080 \
  comment 'imon-meets-transport-main'
```

Apply exactly the reviewed commands without `--dry-run` only during the
coordinated live step. Capture before/after rules. Never use `ufw reset`, disable
the firewall, trust the entire interface, open a port to all sources, or change
existing application/VPN rules. An existing fail2ban restriction on the peer
must be reviewed independently; do not bypass it by widening these rules.

The new edge's observed INPUT policy accepted this UDP tuple. Recheck its
actual rules before using that fact. If a later policy drops it, integrate the
same exact reverse public UDP tuple in that firewall owner's rules. Do not add
UFW to edge merely to reproduce the main's policy.

## Coordinated live activation

1. Keep dedicated new ingress stopped. Preserve the current production and VPN.
   Freeze changes to the four dedicated resources (interface, table, rule
   priority, nft table) while commissioning, and recapture preflight if anything
   changed since generation.
2. Stage the reviewed helper and generator together in
   `/usr/local/lib/imonmeets/`, root-owned and not writable by group/others.
   Stage the chosen role's `runtime.json`, `peer.conf`, `guard.nft`, and its
   private key in `/etc/imonmeets/transport/wg-meets/` (directory 0700, files
   0600, root-owned). Do not copy the other host's private key.
3. Stage the two generated unit files in `/etc/systemd/system/`. Attach the
   ingress dependency drop-in only to the newly dedicated IMON ingress unit.
   Run `systemd-analyze verify` on the staged units and then `systemctl
   daemon-reload`. Neither operation starts the tunnel.
4. Apply the reviewed exact existing-firewall allowances. Start
   `imon-meets-transport-guard.service` separately on each host, inspect the
   dedicated nft table, terminal route and priority rule, and run `guard-check`.
   No WireGuard link is created by this step.
5. Start `imon-meets-transport.service` on both hosts. It creates only `wg-meets`,
   sets the reviewed peer and local key, assigns the local `/32`, and adds the
   metric-10 peer route. A UUID alias and kernel ifindex record ownership. A
   failed step removes the link only if both still match. A partial creation
   before ownership recording is left for explicit operator review; a foreign
   or replaced interface is never deleted.
6. Verify a current mutual handshake and exact AllowedIPs/endpoints using
   filtered `wg show` fields. Never dump private-key-bearing configuration.
   Verify that peer routes use `wg-meets` with the expected private source and
   that default routes, unrelated policy rules and existing VPN listeners are
   unchanged. Start only the dedicated endpoints and test all three approved
   private ports. Validate PROXY v2 preservation and TURN TLS at that layer.
7. Record live confinement only after its own bounded two-host checks,
   including peer-only input and tunnel-loss behavior, pass. The isolated
   harness is necessary evidence but is not a replacement for this. Enable
   the link unit at boot only after the live checks pass. A public DNS/443
   switch remains a separate reviewed task with its own application acceptance.

The lifecycle runner intentionally does not edit UFW or assert that a handshake
or application check passed. A successful `link-start` reports
`confinementAccepted:false` until the external acceptance receipt exists.

## Stop and rollback

For a paused or failed deployment, stop the new dedicated ingress, then stop
`imon-meets-transport.service`. The runner deletes only `wg-meets` proven by its
own alias and ifindex. It keeps the dedicated nft table, policy rule and
unreachable route. This is the normal safe rollback: private destinations keep
failing closed, current public application and VPN remain untouched, and the
same reviewed config can be restarted.

An administrative `ip link set wg-meets down` can remove the explicit active
peer route. Merely setting the link up does not reconstruct that custom route;
the terminal route intentionally continues refusing traffic. Recover the live
deployment with the dedicated unit's normal stop/start, which recreates the
link and exact source-bound route. The namespace harness records this condition
and exercises reapplying only the generator's exact peer `/32` route after
link-up; it never deletes the terminal route or broadens the table.

Stop the link before updating `runtime.json`, `guard.nft`, or `peer.conf`. The
ownership journal contains the original manifest hash; replacing that manifest
while a link exists deliberately prevents automatic deletion with
`LINK_CONFIG_CHANGED`. Preserve the exact old files until the old link stops.

If `guard-start` fails after any mutation, it leaves its incomplete ownership
journal and all guards already installed. Do not blindly delete the journal or
retry. Inspect the exact error, journal, dedicated table/rule/route and saved
inventory. Complete or remove only the identified owned resources in a separate
reviewed maintenance step. Do not force adoption of a same-named resource.

Permanent decommission is manual and separate. First stop all private ingress
and remove their peer dependencies. Disable the dedicated link unit. Delete
only the exact UFW additions after their deletion dry-run. Compare the dedicated
guard hash and ownership journal, verify no transport interface remains, then
remove the destination-only policy rule and terminal peer route while the nft
guard still blocks fallback. Delete the dedicated nft table last. Never flush
whole route tables, the ruleset, conntrack, or unrelated UFW rules. Archive or
remove private keys only under the operator's normal key-retention policy.

## References

- [WireGuard quick start](https://www.wireguard.com/quickstart/): explicit link,
  key and peer setup; keepalive behavior.
- [wg-quick manual](https://git.zx2c4.com/wireguard-tools/about/src/man/wg-quick.8):
  inferred routes, DNS behavior and why this plan uses explicit `wg`/`ip` steps.
- [ip-rule manual](https://man7.org/linux/man-pages/man8/ip-rule.8.html): rule
  ordering and lookup behavior.
- [ip-route manual](https://man7.org/linux/man-pages/man8/ip-route.8.html):
  terminal unreachable routes.
- [nftables chain configuration](https://wiki.nftables.org/wiki-nftables/index.php/Configuring_chains):
  base-chain priorities and accept/drop semantics.
- [Ubuntu UFW manual](https://manpages.ubuntu.com/manpages/noble/en/man8/ufw.8.html):
  dry-run and exact interface/source/destination/port syntax.
- [Linux IPv4 routing notifier](https://github.com/torvalds/linux/blob/master/net/ipv4/fib_frontend.c)
  and [nexthop state handling](https://code.googlesource.com/linux/torvalds/linux/+/fdce8bd38037a4a2b2961ca4abffaab195690b30/net/ipv4/fib_semantics.c):
  administrative link-down marks affected routes dead and flushes them;
  link-up reconstructs address-derived routes.
