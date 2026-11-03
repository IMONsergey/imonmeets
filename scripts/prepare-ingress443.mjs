import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nginxTlsLayout, renderNginxTlsContext } from "./ingress-nginx-tls.mjs";

export const HAPROXY_IMAGE =
  "haproxy:3.0-alpine@sha256:f06f6cc1c25c7071e62d955d8e67a33d6935066ced8fac496cdd0ad9ffdd17f3";

function hostname(value, name) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !value.includes(".") ||
    !value
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`${name} must be a lowercase DNS hostname`);
  }
  return value;
}

function origin(value, protocol, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      `${name} must use ${protocol}// with the standard port and no path or credentials`,
    );
  }
  return hostname(parsed.hostname, name);
}

export function ingressConfig(env) {
  const ip = env.INGRESS_PUBLIC_IP;
  const vpnIp = env.VPN_PUBLIC_IP;
  if (
    isIP(ip || "") !== 4 ||
    isIP(vpnIp || "") !== 4 ||
    ip === "0.0.0.0" ||
    vpnIp === "0.0.0.0" ||
    ip === vpnIp
  ) {
    throw new Error(
      "INGRESS_PUBLIC_IP must be an explicit non-wildcard IPv4 different from VPN_PUBLIC_IP",
    );
  }
  const app = origin(env.APP_URL, "https:", "APP_URL");
  const rtc = origin(env.LIVEKIT_URL, "wss:", "LIVEKIT_URL");
  const turn = hostname(env.TURN_PUBLIC_HOST, "TURN_PUBLIC_HOST");
  const storage =
    env.RECORDING_ENABLED === "true"
      ? origin(env.S3_PUBLIC_ENDPOINT, "https:", "S3_PUBLIC_ENDPOINT")
      : undefined;
  if (
    new Set([app, rtc, turn, ...(storage ? [storage] : [])]).size !==
    (storage ? 4 : 3)
  ) {
    throw new Error(
      "Web, signaling, TURN and recording storage need distinct hostnames",
    );
  }
  if (storage && env.S3_BUCKET !== "imon-recordings")
    throw new Error("Only the private imon-recordings bucket is supported");
  if (env.LIVEKIT_SIGNALING_AUTH_ENABLED !== "true")
    throw new Error("Enable the signaling admission guard first");
  for (const key of ["ORIGIN_PROXY_SECRET", "LIVEKIT_SIGNALING_AUTH_SECRET"]) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(env[key] || ""))
      throw new Error(`${key} must contain 32+ base64url characters`);
  }
  const certificate = env.TLS_CERT_NAME || "imonmeets-commercial";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(certificate))
    throw new Error("Invalid TLS_CERT_NAME");
  return {
    ip,
    vpnIp,
    app,
    rtc,
    turn,
    storage,
    certificate,
    proxySecret: env.ORIGIN_PROXY_SECRET,
    signalingSecret: env.LIVEKIT_SIGNALING_AUTH_SECRET,
  };
}

// The optional layout exists for an isolated acceptance harness. The CLI always
// uses the fixed public 443 and loopback-only private ports below.
export function renderIngress(c, layout = {}) {
  const p = {
    bind: c.ip,
    publicPort: 443,
    httpPort: 80,
    turnPort: 5349,
    acme: "/var/lib/imonmeets-acme",
    ...nginxTlsLayout(c),
    ...layout,
  };
  const webHosts = [c.app, c.rtc, ...(c.storage ? [c.storage] : [])];
  const allHosts = [...webHosts, c.turn];
  const httpServers = `server {
    listen ${p.bind}:${p.httpPort} default_server;
    server_name _;
    access_log off;
    return 444;
}
server {
    listen ${p.bind}:${p.httpPort};
    server_name ${allHosts.join(" ")};
    access_log off;
    location ^~ /.well-known/acme-challenge/ {
        root ${p.acme};
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 308 https://$host$request_uri; }
}
`;
  const nginx = renderNginxTlsContext(c, p, httpServers);
  const haproxy = `# Public SNI routing. VPN_PUBLIC_IP is intentionally never bound.
global
    maxconn 4096
    user haproxy
    group haproxy
defaults
    mode tcp
    timeout connect 5s
    timeout client 1h
    timeout server 1h
    timeout client-fin 10s
    timeout server-fin 10s
frontend imonmeets_tls
    bind ${p.bind}:${p.publicPort}
    tcp-request inspect-delay 5s
    acl known_sni req.ssl_sni -i ${allHosts.join(" ")}
    tcp-request content reject if { req.ssl_hello_type 1 } !known_sni
    tcp-request content accept if { req.ssl_hello_type 1 } known_sni
    tcp-request content reject if WAIT_END
    use_backend imonmeets_turn if { req.ssl_sni -i ${c.turn} }
    default_backend imonmeets_https
backend imonmeets_https
    server nginx 127.0.0.1:${p.nginxPort} send-proxy-v2
backend imonmeets_turn
    # coturn receives an unmodified TLS stream, without a PROXY prefix.
    server turn 127.0.0.1:${p.turnPort}
`;
  return {
    nginx,
    haproxy,
    trust: `proxy_set_header X-IMON-Proxy-Secret "${c.proxySecret}";\n`,
    signal: `proxy_set_header X-IMON-LiveKit-Auth "${c.signalingSecret}";\n`,
  };
}

async function main() {
  const c = ingressConfig(process.env);
  const output = path.resolve(
    process.env.INGRESS_OUTPUT_DIR ||
      fileURLToPath(new URL("../deploy/ingress443-private", import.meta.url)),
  );
  const rendered = renderIngress(c);
  // Refuse replacement: generation cannot silently overwrite an installed candidate.
  await mkdir(output, { mode: 0o700 });
  await chmod(output, 0o700);
  const files = {
    "nginx.http.conf": rendered.nginx,
    "haproxy.cfg": rendered.haproxy,
    "imonmeets-commercial-trust.conf": rendered.trust,
    "imonmeets-signaling-auth.conf": rendered.signal,
  };
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(output, name), text, { mode: 0o600, flag: "wx" });
  }
  const plan = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    publicIp: c.ip,
    preservedVpnIp: c.vpnIp,
    appUrl: `https://${c.app}`,
    livekitUrl: `wss://${c.rtc}`,
    turnUrl: `turns:${c.turn}:443?transport=tcp`,
    s3PublicEndpoint: c.storage ? `https://${c.storage}` : null,
    image: HAPROXY_IMAGE,
    publicConfigurationSha256: Object.fromEntries(
      ["nginx.http.conf", "haproxy.cfg"].map((n) => [
        n,
        createHash("sha256").update(files[n]).digest("hex"),
      ]),
    ),
    applied: false,
    externalAcceptance: false,
  };
  await writeFile(
    path.join(output, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Prepared a private 443 candidate. No listener, DNS, certificate, VPN, firewall or host configuration was changed.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
