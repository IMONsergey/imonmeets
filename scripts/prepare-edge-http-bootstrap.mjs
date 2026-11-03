#!/usr/bin/env node
// Explicit native HTTP-only candidate. Generation never installs or starts it.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgeVpsCandidate } from "./prepare-edge-vps-ingress.mjs";
import { ACME_MAIN_PORT, absolutePath, required } from "./edge-certificate-policy.mjs";
import { localChallenge, quiet, renderEdgeHttp } from "./edge-http-config.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const roles = {
  main: { unit: "imonmeets-main-acme-bootstrap", webroot: "/var/lib/imonmeets-acme" },
  edge: { unit: "imonmeets-edge-http-bootstrap", webroot: "/var/lib/imonmeets-witness-acme" },
};

function nginxRoot(role) {
  const run = `/run/${roles[role].unit}`;
  return `# Standalone native HTTP bootstrap; no global nginx includes.
worker_processes 1;
pid ${run}/nginx.pid;
error_log stderr crit;
events { worker_connections 256; }
http {
    default_type application/octet-stream;
    access_log off;
    client_max_body_size 1k;
    client_header_timeout 5s;
    client_body_timeout 5s;
    keepalive_timeout 5s;
    client_body_temp_path ${run}/client-body;
    proxy_temp_path ${run}/proxy;
    fastcgi_temp_path ${run}/fastcgi;
    uwsgi_temp_path ${run}/uwsgi;
    scgi_temp_path ${run}/scgi;
    include /etc/imonmeets-http-bootstrap/${role}/http.conf;
}
`;
}

function nativeUnit(role) {
  const { unit, webroot } = roles[role];
  const capability = role === "edge" ? "CAP_NET_BIND_SERVICE" : "";
  return `[Unit]
Description=IMON Meets ${role} native HTTP bootstrap only
Requires=imon-meets-transport.service
BindsTo=imon-meets-transport.service
After=network-online.target imon-meets-transport.service
[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/
RuntimeDirectory=${unit}
RuntimeDirectoryMode=0700
PIDFile=/run/${unit}/nginx.pid
ExecStart=/usr/sbin/nginx -p /run/${unit}/ -e stderr -c /etc/imonmeets-http-bootstrap/${role}/nginx.conf -g "daemon off;"
# systemd signals only this unit's foreground master and owned cgroup.
KillSignal=SIGQUIT
KillMode=mixed
TimeoutStopSec=15
Restart=no
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=${capability}
AmbientCapabilities=${capability}
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadOnlyPaths=${webroot}
ReadWritePaths=/run/${unit}
RestrictAddressFamilies=AF_UNIX AF_INET
MemoryMax=128M
CPUQuota=50%
TasksMax=32
[Install]
WantedBy=multi-user.target
`;
}

export function buildEdgeHttpBootstrapCandidate(env) {
  const edge = buildEdgeVpsCandidate(env).plan;
  required(env.EDGE_MAIN_ACME_PORT === String(ACME_MAIN_PORT), "ACME_PORT_NOT_APPROVED");
  const mainHosts = edge.routes.filter((r) => r.endpoint !== "127.0.0.1:8446").map((r) => r.sni);
  const witnessHost = edge.routes.find((r) => r.endpoint === "127.0.0.1:8446").sni;
  // No inherited real-IP settings: remote_addr is the actual TCP peer. This
  // guard also covers early URI/method/default-server return statements.
  const peerGuard = `    if ($remote_addr != "${edge.tunnel.localIp}") { return 403; }`;
  const mainHttp = `# Dedicated native ACME owner. Stop this unit before a bridge binds this port.
server {
    listen ${edge.tunnel.mainIp}:${ACME_MAIN_PORT} default_server;
    server_name _;
${quiet}
${peerGuard}
    return 404;
}
server {
    listen ${edge.tunnel.mainIp}:${ACME_MAIN_PORT};
    server_name ${mainHosts.join(" ")};
${quiet}
${peerGuard}
${localChallenge(roles.main.webroot, `        allow ${edge.tunnel.localIp}/32;\n        deny all;\n`)}
    location / { return 404; }
}
`;
  const files = {
    "nginx.main-http.conf": mainHttp,
    "nginx.main.conf": nginxRoot("main"),
    "imonmeets-main-acme-bootstrap.service": nativeUnit("main"),
    "nginx.edge-http.conf": renderEdgeHttp({ edge, mainHosts, witnessHost, witnessWebroot: roles.edge.webroot }),
    "nginx.edge.conf": nginxRoot("edge"),
    "imonmeets-edge-http-bootstrap.service": nativeUnit("edge"),
  };
  const install = Object.fromEntries(Object.entries(roles).map(([role, { unit, webroot }]) => [role, {
    service: `${unit}.service`, user: "www-data", group: "www-data", webroot,
    configurationDirectory: `/etc/imonmeets-http-bootstrap/${role}`,
    configurationOwner: "root:root", configurationDirectoryMode: "0755", configurationFileMode: "0644",
    runtimeDirectory: `/run/${unit}`,
    files: {
      [`nginx.${role}.conf`]: `/etc/imonmeets-http-bootstrap/${role}/nginx.conf`,
      [`nginx.${role}-http.conf`]: `/etc/imonmeets-http-bootstrap/${role}/http.conf`,
      [`${unit}.service`]: `/etc/systemd/system/${unit}.service`,
    },
  }]));
  return { files, plan: {
    schema: 1, mode: "native-http-bootstrap-only", status: "CANDIDATE_NOT_DEPLOYED",
    mainHosts, witnessHost,
    mainListener: { address: edge.tunnel.mainIp, port: ACME_MAIN_PORT, source: `${edge.tunnel.localIp}/32` },
    edgeListener: { address: edge.publicListener.address, port: 80 },
    mainWebroot: roles.main.webroot, witnessWebroot: roles.edge.webroot,
    mainAcmePortOwner: "imonmeets-main-acme-bootstrap.service",
    handoff: { stopNativeOwnerBeforeBridge: true, bridgeCannotStartConcurrently: true,
      startConsumersExplicitlyAfterTransportRecovery: true, sharedNginxMustStayIndependent: true },
    configurationParent: { path: "/etc/imonmeets-http-bootstrap", owner: "root:root", mode: "0755" },
    install,
    configurationSha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
    intendedAppAStaysOnMain: true, sourceAclAloneProvesTransport: false,
    runtimeContextsRequired: false, privateInputsRequired: false,
    nginxConfigTestCanBind: true,
    productionChanges: false, deployed: false, dnsChanged: false, applicationReleaseChanged: false,
    nativeNginxAccepted: false, serviceLifecycleAccepted: false, httpChallengeAccepted: false,
    certificateIssued: false, renewalAccepted: false, witnessEnrolled: false, public443Accepted: false,
  } };
}

export async function writeEdgeHttpBootstrapCandidate(output, env) {
  const { files, plan } = buildEdgeHttpBootstrapCandidate(env);
  absolutePath(output);
  let created = false;
  try {
    await mkdir(output, { mode: 0o700 }); created = true;
    for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(output, name), bytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    if (created) await rm(output, { recursive: true, force: true }).catch(() => {});
    required(false, created ? "OUTPUT_WRITE_FAILED" : "OUTPUT_EXISTS_OR_INVALID");
  }
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  (async () => {
    required(process.argv.length === 4 && process.argv[2] === "--output", "INVALID_ARGUMENTS");
    const p = await writeEdgeHttpBootstrapCandidate(process.argv[3], process.env);
    process.stdout.write(JSON.stringify({ status: p.status, mode: p.mode, deployed: false, configurationSha256: p.configurationSha256 }) + "\n");
  })().catch((e) => {
    process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "GENERATION_FAILED" }) + "\n");
    process.exitCode = 1;
  });
}
