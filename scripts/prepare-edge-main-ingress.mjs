#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgeVpsCandidate } from "./prepare-edge-vps-ingress.mjs";
import { HAPROXY_IMAGE } from "./prepare-ingress443.mjs";
import { nginxTlsLayout, renderNginxTlsContext } from "./ingress-nginx-tls.mjs";

class CandidateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function invalid(field) {
  throw new CandidateError(`INVALID_${field}`);
}

function configuration(env) {
  // Reuse the complete strict edge contract, including unique SNI names and
  // literal, distinct RFC1918 transport endpoints. No interface is discovered.
  const { plan: edge } = buildEdgeVpsCandidate(env);
  for (const field of ["ORIGIN_PROXY_SECRET", "LIVEKIT_SIGNALING_AUTH_SECRET"]) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env[field] || "")) invalid(field);
  }
  const certificate = env.TLS_CERT_NAME;
  if (typeof certificate !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(certificate))
    invalid("TLS_CERT_NAME");
  if (env.RECORDING_ENABLED === "true" && env.S3_BUCKET !== "imon-recordings")
    invalid("S3_BUCKET");
  if (env.EDGE_MANAGED_TLS !== undefined && !["true", "false"].includes(env.EDGE_MANAGED_TLS))
    invalid("EDGE_MANAGED_TLS");
  if (env.EDGE_MAIN_ACME_PORT !== undefined && env.EDGE_MAIN_ACME_PORT !== "18080")
    invalid("EDGE_MAIN_ACME_PORT");
  // The edge validator above already rejected URL normalization, paths,
  // credentials, control characters, non-ASCII names and explicit ports.
  const host = (value, scheme) => value.slice(scheme.length).replace(/\/$/, "").toLowerCase();
  return {
    edge,
    mainIp: edge.tunnel.mainIp,
    edgeIp: edge.tunnel.localIp,
    tls: {
      app: host(env.APP_URL, "https://"),
      rtc: host(env.LIVEKIT_URL, "wss://"),
      turn: env.TURN_PUBLIC_HOST.toLowerCase(),
      storage: env.RECORDING_ENABLED === "true" ? host(env.S3_PUBLIC_ENDPOINT, "https://") : undefined,
      certificate,
    },
    proxySecret: env.ORIGIN_PROXY_SECRET,
    signalingSecret: env.LIVEKIT_SIGNALING_AUTH_SECRET,
    managedTls: env.EDGE_MANAGED_TLS === "true",
    acmeBridge: env.EDGE_MAIN_ACME_PORT === "18080",
  };
}

export function buildEdgeMainCandidate(env) {
  const c = configuration(env);
  // These are byte-preserving TCP bridges. In particular, never add or consume
  // a PROXY prefix: the edge already sends exactly one to nginx and none to TURN.
  const haproxy = `# Closed main-side candidate; no tunnel, listener or host setting is installed.
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
frontend imon_main_https
    bind ${c.mainIp}:8445
    acl edge_peer src ${c.edgeIp}/32
    tcp-request connection reject unless edge_peer
    default_backend imon_main_nginx_loopback
backend imon_main_nginx_loopback
    server nginx 127.0.0.1:8445 source 127.0.0.1
frontend imon_main_turn
    bind ${c.mainIp}:5349
    acl edge_peer src ${c.edgeIp}/32
    tcp-request connection reject unless edge_peer
    default_backend imon_main_turn_loopback
backend imon_main_turn_loopback
    server turn 127.0.0.1:5349 source 127.0.0.1
${c.acmeBridge ? `frontend imon_main_acme
    bind ${c.mainIp}:18080
    acl edge_peer src ${c.edgeIp}/32
    tcp-request connection reject unless edge_peer
    default_backend imon_main_acme_loopback
backend imon_main_acme_loopback
    server acme 127.0.0.1:18080 source 127.0.0.1
` : ""}`;
  const nginx = renderNginxTlsContext(c.tls, nginxTlsLayout(c.tls, c.managedTls ? {
    cert: "/etc/imonmeets/tls/main/current/fullchain.pem",
    key: "/etc/imonmeets/tls/main/current/privkey.pem",
  } : {}));
  const trust = `proxy_set_header X-IMON-Proxy-Secret "${c.proxySecret}";\n`;
  const signal = `proxy_set_header X-IMON-LiveKit-Auth "${c.signalingSecret}";\n`;
  const plan = {
    schema: 1,
    status: "CANDIDATE_NOT_DEPLOYED",
    topology: "edge-main-closed-tcp-bridge",
    image: HAPROXY_IMAGE,
    edgePublicIp: c.edge.publicListener.address,
    preservedVpnIp: c.edge.preservedVpnIp,
    mainTunnelIp: c.mainIp,
    allowedEdgeSource: `${c.edgeIp}/32`,
    listeners: [
      { address: c.mainIp, port: 8445, backend: "127.0.0.1:8445", inputProtocol: "PROXY-v2-then-original-TLS", proxyPrefixHandling: "unchanged" },
      { address: c.mainIp, port: 5349, backend: "127.0.0.1:5349", inputProtocol: "original-TLS", proxyPrefixHandling: "none" },
      ...(c.acmeBridge ? [{ address: c.mainIp, port: 18080, backend: "127.0.0.1:18080", inputProtocol: "original-HTTP-01", proxyPrefixHandling: "none" }] : []),
    ],
    nginx: {
      listen: "127.0.0.1:8445",
      trustedProxySource: "127.0.0.1",
      serverNames: [c.tls.app, c.tls.rtc, ...(c.tls.storage ? [c.tls.storage] : [])],
      certificateLineage: c.tls.certificate,
      managedCertificateSnapshot: c.managedTls,
      httpIncluded: false,
      acmeIncluded: false,
      requiredPrivateIncludes: ["imonmeets-commercial-trust.conf", "imonmeets-signaling-auth.conf"],
    },
    publicConfigurationSha256: {
      "haproxy-main.cfg": createHash("sha256").update(haproxy).digest("hex"),
      "nginx.tls.conf": createHash("sha256").update(nginx).digest("hex"),
    },
    productionChanges: false,
    deployed: false,
    tunnelConfigured: false,
    tunnelConfinementVerified: false,
    listenerSourceAclProvesConfinement: false,
    runtimeAccepted: false,
    certificatesVerified: false,
    dnsChanged: false,
    public443Accepted: false,
  };
  return { haproxy, nginx, trust, signal, plan };
}

export async function writeEdgeMainCandidate(output, env) {
  const result = buildEdgeMainCandidate(env);
  if (typeof output !== "string" || !path.isAbsolute(output))
    throw new CandidateError("OUTPUT_EXISTS_OR_INVALID");
  let created = false;
  try {
    // The parent must be operator-controlled and stable while writing.
    await mkdir(output, { mode: 0o700 });
    created = true;
    for (const [name, content] of Object.entries({
      "haproxy-main.cfg": result.haproxy,
      "nginx.tls.conf": result.nginx,
      "imonmeets-commercial-trust.conf": result.trust,
      "imonmeets-signaling-auth.conf": result.signal,
    })) {
      await writeFile(path.join(output, name), content, { flag: "wx", mode: 0o600 });
    }
    // A plan is written last. Private include contents and hashes are omitted.
    await writeFile(path.join(output, "plan.json"), JSON.stringify(result.plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    if (created) await rm(output, { recursive: true, force: true }).catch(() => {});
    throw new CandidateError(created ? "OUTPUT_WRITE_FAILED" : "OUTPUT_EXISTS_OR_INVALID");
  }
  return result.plan;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !path.isAbsolute(args[1]))
    throw new CandidateError("INVALID_ARGUMENTS");
  const plan = await writeEdgeMainCandidate(args[1], process.env);
  process.stdout.write(JSON.stringify({
    ok: true,
    status: plan.status,
    publicConfigurationSha256: plan.publicConfigurationSha256,
    productionChanges: false,
    deployed: false,
    public443Accepted: false,
  }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
      ? error.code : "GENERATION_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  });
}
