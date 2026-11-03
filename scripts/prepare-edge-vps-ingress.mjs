#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HAPROXY_IMAGE } from "./prepare-ingress443.mjs";

class CandidateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid(field) {
  throw new CandidateError(`INVALID_${field}`);
}

function octets(value, field) {
  // isIP rejects shortened, octal, hexadecimal, CIDR, port and whitespace forms.
  if (typeof value !== "string" || isIP(value) !== 4) invalid(field);
  return value.split(".").map(Number);
}

function isPrivate([a, b]) {
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

function privateIp(value, field) {
  if (!isPrivate(octets(value, field))) invalid(field);
  return value;
}

function publicIp(value, field) {
  const p = octets(value, field);
  const [a, b] = p;
  // Conservative public-unicast policy: exclude special-purpose space, including
  // protocol anycasts. This does not establish provider allocation or routing.
  // https://www.iana.org/assignments/iana-ipv4-special-registry/
  const special24 = [
    "192.0.0",
    "192.0.2",
    "192.31.196",
    "192.52.193",
    "192.88.99",
    "192.175.48",
    "198.51.100",
    "203.0.113",
  ];
  if (
    a === 0 ||
    a === 127 ||
    a >= 224 ||
    isPrivate(p) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 198 && (b === 18 || b === 19)) ||
    special24.includes(p.slice(0, 3).join("."))
  )
    invalid(field);
  return value;
}

function hostname(value, field) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    /[^\x21-\x7e]/.test(value)
  )
    invalid(field);
  const host = value.toLowerCase();
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    isIP(host) ||
    !/[a-z]/.test(labels.at(-1)) ||
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    invalid(field);
  return host;
}

function origin(value, scheme, field) {
  const prefix = `${scheme}://`;
  if (typeof value !== "string" || !value.startsWith(prefix)) invalid(field);
  // Parse the restricted origin directly so URL normalization cannot silently
  // remove credentials, control bytes, default ports or non-ASCII input.
  const host = value.slice(prefix.length).replace(/\/$/, "");
  return hostname(host, field);
}

function configuration(env) {
  const ip = publicIp(env.EDGE_PUBLIC_IP, "EDGE_PUBLIC_IP");
  const vpnIp = publicIp(env.VPN_PUBLIC_IP, "VPN_PUBLIC_IP");
  if (ip === vpnIp) throw new CandidateError("PUBLIC_IP_COLLISION");
  const local = privateIp(env.EDGE_TUNNEL_LOCAL_IP, "EDGE_TUNNEL_LOCAL_IP");
  const main = privateIp(env.EDGE_MAIN_TUNNEL_IP, "EDGE_MAIN_TUNNEL_IP");
  if (local === main) throw new CandidateError("TUNNEL_IP_COLLISION");
  if (!["true", "false"].includes(env.RECORDING_ENABLED))
    invalid("RECORDING_ENABLED");
  if (env.LIVEKIT_SIGNALING_AUTH_ENABLED !== "true")
    throw new CandidateError("SIGNALING_GUARD_REQUIRED");
  const app = origin(env.APP_URL, "https", "APP_URL");
  const rtc = origin(env.LIVEKIT_URL, "wss", "LIVEKIT_URL");
  const turn = hostname(env.TURN_PUBLIC_HOST, "TURN_PUBLIC_HOST");
  const witness = hostname(env.EDGE_WITNESS_HOST, "EDGE_WITNESS_HOST");
  const storage =
    env.RECORDING_ENABLED === "true"
      ? origin(env.S3_PUBLIC_ENDPOINT, "https", "S3_PUBLIC_ENDPOINT")
      : null;
  const hosts = [app, rtc, turn, witness, ...(storage ? [storage] : [])];
  if (new Set(hosts).size !== hosts.length)
    throw new CandidateError("HOSTNAME_COLLISION");
  return { ip, vpnIp, local, main, app, rtc, turn, witness, storage };
}

export function buildEdgeVpsCandidate(env) {
  const c = configuration(env);
  const web = [c.app, c.rtc, ...(c.storage ? [c.storage] : [])];
  const all = [...web, c.turn, c.witness];
  // The closed transport must be prepared independently. A source address does
  // not select/prove a tunnel interface and is never a substitute for firewall
  // and routing enforcement. It is deliberately absent from the local witness.
  const haproxy = `# TLS-only candidate. No tunnel, DNS, certificate or listener is installed.
global
    maxconn 256
    nbthread 1
    user haproxy
    group haproxy
defaults
    mode tcp
    timeout connect 5s
    timeout client 1h
    timeout server 1h
    timeout client-fin 10s
    timeout server-fin 10s
frontend imon_edge_tls
    bind ${c.ip}:443
    tcp-request inspect-delay 5s
    acl known_sni req.ssl_sni -i ${all.join(" ")}
    acl web_sni req.ssl_sni -i ${web.join(" ")}
    acl turn_sni req.ssl_sni -i ${c.turn}
    acl witness_sni req.ssl_sni -i ${c.witness}
    tcp-request content reject if { req.ssl_hello_type 1 } !known_sni
    tcp-request content accept if { req.ssl_hello_type 1 } known_sni
    tcp-request content reject if WAIT_END
    use_backend imon_edge_https if web_sni
    use_backend imon_edge_turn if turn_sni
    use_backend imon_edge_witness if witness_sni
backend imon_edge_https
    server nginx ${c.main}:8445 send-proxy-v2 source ${c.local}
backend imon_edge_turn
    server turn ${c.main}:5349 source ${c.local}
backend imon_edge_witness
    server witness_tls 127.0.0.1:8446
`;
  const routes = [
    ...web.map((sni) => ({
      sni,
      endpoint: `${c.main}:8445`,
      proxyProtocol: "v2",
    })),
    { sni: c.turn, endpoint: `${c.main}:5349`, proxyProtocol: "none" },
    { sni: c.witness, endpoint: "127.0.0.1:8446", proxyProtocol: "none" },
  ];
  const plan = {
    schema: 1,
    status: "CANDIDATE_NOT_DEPLOYED",
    topology: "edge-vps-tls-passthrough",
    image: HAPROXY_IMAGE,
    haproxySha256: createHash("sha256").update(haproxy).digest("hex"),
    publicListener: { address: c.ip, port: 443 },
    preservedVpnIp: c.vpnIp,
    tunnel: {
      localIp: c.local,
      mainIp: c.main,
      sourceBindingProvesConfinement: false,
    },
    routes,
    expectedTransport: "original-client-tls",
    expectedMainNginxContract:
      "TLS with PROXY v2, protected signaling admission and signed-object routing",
    expectedMainTurnContract:
      "native TLS without PROXY; relay and SFU stay on main",
    expectedWitnessContract:
      "local TLS wrapper on 8446 before existing loopback HTTP 3551",
    productionChanges: false,
    deployed: false,
    tunnelConfigured: false,
    tunnelConfinementVerified: false,
    dnsChanged: false,
    certificatesVerified: false,
    httpAcmeIncluded: false,
    witnessEnrolled: false,
    externalMediaAccepted: false,
    public443Accepted: false,
  };
  return { haproxy, plan };
}

export async function writeEdgeVpsCandidate(output, env) {
  const { haproxy, plan } = buildEdgeVpsCandidate(env);
  if (typeof output !== "string" || !path.isAbsolute(output))
    throw new CandidateError("OUTPUT_EXISTS_OR_INVALID");
  let created = false;
  try {
    // No recursive mkdir: the operator supplies an existing staging parent.
    // An existing file, directory or symlink is never a replacement target.
    await mkdir(output, { mode: 0o700 });
    created = true;
    await writeFile(path.join(output, "haproxy.cfg"), haproxy, {
      flag: "wx",
      mode: 0o600,
    });
    // The plan is last; a missing plan is an incomplete generation, not a receipt.
    await writeFile(
      path.join(output, "plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    if (created)
      await rm(output, { recursive: true, force: true }).catch(() => {});
    throw new CandidateError(
      created ? "OUTPUT_WRITE_FAILED" : "OUTPUT_EXISTS_OR_INVALID",
    );
  }
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !path.isAbsolute(args[1]))
    throw new CandidateError("INVALID_ARGUMENTS");
  const plan = await writeEdgeVpsCandidate(args[1], process.env);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      status: plan.status,
      haproxySha256: plan.haproxySha256,
      productionChanges: false,
      deployed: false,
      public443Accepted: false,
    }) + "\n",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const code =
      error instanceof CandidateError ? error.code : "GENERATION_FAILED";
    process.stderr.write(
      JSON.stringify({
        ok: false,
        code,
        productionChanges: false,
        deployed: false,
        public443Accepted: false,
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
