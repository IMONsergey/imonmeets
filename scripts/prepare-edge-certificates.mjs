#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdgeVpsCandidate } from "./prepare-edge-vps-ingress.mjs";
import { ACME_MAIN_PORT, absolutePath, certificateName, renewalConfig, required } from "./edge-certificate-policy.mjs";
import { quiet, renderEdgeHttp, renderLoopbackMainAcme } from "./edge-http-config.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
function witnessLocation(uri, method, host) {
  return `    location = ${uri} {
        if ($request_uri != "${uri}") { return 404; }
        if ($request_method != ${method}) { return 405; }
        proxy_pass http://127.0.0.1:3551;
        proxy_http_version 1.1;
        proxy_set_header Host ${host};
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_connect_timeout 2s;
        proxy_read_timeout 10s;
        proxy_send_timeout 10s;
        proxy_buffering off;
    }`;
}
function certificateCommands(config, webroot) {
  const { role, certificateName: name, domains, runtime } = config;
  const common = ["--config", `/etc/imonmeets/certificates/${role}-certbot.ini`,
    "--config-dir", `/etc/imonmeets/acme/${role}`,
    "--work-dir", `/var/lib/imonmeets-certbot-${role}`,
    "--logs-dir", `/var/log/imonmeets-certbot-${role}`,
    "--no-directory-hooks", "--non-interactive", "--cert-name", name];
  const hook = `${runtime.node} ${runtime.codeDirectory}/renew-edge-certificate.mjs --config /etc/imonmeets/certificates/${role}-renewal.json`;
  const issue = ["/usr/bin/certbot", "certonly", ...common, "--webroot", "--webroot-path", webroot,
    "--preferred-challenges", "http", ...domains.flatMap((d) => ["-d", d])];
  return {
    issue, issueDryRun: [...issue, "--dry-run"],
    stageInitial: [runtime.node, `${runtime.codeDirectory}/renew-edge-certificate.mjs`, "--config", `/etc/imonmeets/certificates/${role}-renewal.json`, "--stage-initial"],
    reconcile: [runtime.node, `${runtime.codeDirectory}/renew-edge-certificate.mjs`, "--config", `/etc/imonmeets/certificates/${role}-renewal.json`, "--reconcile"],
    renew: ["/usr/bin/certbot", "renew", ...common, "--deploy-hook", hook],
    renewalDryRun: ["/usr/bin/certbot", "renew", ...common, "--dry-run"],
  };
}
function renewalUnit(role, commands) {
  // Every path/name was constrained above; the hook is a single quoted argv.
  const command = (argv) => argv.map((s) => s.includes(" ") ? `"${s}"` : s).join(" ");
  return `[Unit]
Description=Renew only IMON Meets ${role} certificate
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=180
ExecStart=${command(commands.renew)}
# Retry a rolled-back deploy hook even when Certbot is no longer due.
ExecStart=${command(commands.reconcile)}
`;
}
export function buildEdgeCertificateCandidate(env) {
  const edge = buildEdgeVpsCandidate(env).plan;
  required(env.EDGE_MAIN_ACME_PORT === String(ACME_MAIN_PORT), "ACME_PORT_NOT_APPROVED");
  required(env.EDGE_MANAGED_TLS === "true", "MANAGED_TLS_REQUIRED");
  const mainHosts = edge.routes.filter((r) => r.endpoint !== "127.0.0.1:8446").map((r) => r.sni);
  const witnessHost = edge.routes.find((r) => r.endpoint === "127.0.0.1:8446").sni;
  const mainName = certificateName(env.TLS_CERT_NAME);
  const witnessName = certificateName(env.EDGE_WITNESS_TLS_CERT_NAME);
  required(mainName !== witnessName, "CERTIFICATE_NAME_COLLISION");
  required(typeof env.ACME_EMAIL === "string" && /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(env.ACME_EMAIL), "INVALID_ACME_EMAIL");
  let contexts;
  try { contexts = [JSON.parse(env.EDGE_MAIN_RENEWAL_CONTEXT), JSON.parse(env.EDGE_WITNESS_RENEWAL_CONTEXT)]; }
  catch { required(false, "INVALID_RUNTIME_CONTEXT"); }
  const main = renewalConfig("main", mainName, mainHosts, contexts[0]);
  const witness = renewalConfig("witness", witnessName, [witnessHost], contexts[1]);
  const mainWebroot = "/var/lib/imonmeets-acme";
  const witnessWebroot = "/var/lib/imonmeets-witness-acme";
  const edgeHttp = renderEdgeHttp({ edge, mainHosts, witnessHost, witnessWebroot });
  const mainAcme = renderLoopbackMainAcme({ mainHosts, mainWebroot });
  const witnessTls = `# Install only after the initial managed witness snapshot exists.
server {
    listen 127.0.0.1:8446 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
    ssl_protocols TLSv1.2 TLSv1.3;
${quiet}
    return 444;
}
server {
    listen 127.0.0.1:8446 ssl;
    server_name ${witnessHost};
${quiet}
    ssl_certificate ${witness.store}/current/fullchain.pem;
    ssl_certificate_key ${witness.store}/current/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_tickets off;
    client_max_body_size 36k;
    client_body_buffer_size 36k;
    client_body_timeout 10s;
    client_header_timeout 5s;
    keepalive_timeout 5s;
${witnessLocation("/health", "GET", witnessHost)}
${witnessLocation("/intents", "POST", witnessHost)}
${witnessLocation("/checkpoint", "POST", witnessHost)}
    location / { return 404; }
}
`;
  const files = {
    "nginx.edge-http.conf": edgeHttp,
    "nginx.main-acme.conf": mainAcme,
    "nginx.edge-witness-tls.conf": witnessTls,
    "nginx.edge.conf": `user www-data;
worker_processes 1;
pid /run/imonmeets-edge-nginx/nginx.pid;
error_log /dev/null crit;
events { worker_connections 256; }
http {
    default_type application/octet-stream;
    access_log off;
    client_body_temp_path /tmp/imonmeets-edge-client-body;
    proxy_temp_path /tmp/imonmeets-edge-proxy;
    include /etc/imonmeets/edge-nginx/http.conf;
    include /etc/imonmeets/edge-nginx/tls/*.conf;
}
`,
    "imonmeets-edge-nginx.service": `[Unit]
Description=IMON Meets edge HTTP and local witness TLS
Requires=imon-meets-transport.service
BindsTo=imon-meets-transport.service
After=network-online.target imon-meets-transport.service
[Service]
Type=forking
RuntimeDirectory=imonmeets-edge-nginx
PIDFile=/run/imonmeets-edge-nginx/nginx.pid
ExecStartPre=/usr/sbin/nginx -t -c /etc/imonmeets/edge-nginx/nginx.conf
ExecStart=/usr/sbin/nginx -c /etc/imonmeets/edge-nginx/nginx.conf
ExecReload=/usr/sbin/nginx -t -c /etc/imonmeets/edge-nginx/nginx.conf
ExecReload=/bin/kill -s HUP $MAINPID
KillSignal=SIGQUIT
TimeoutStopSec=15
PrivateTmp=true
MemoryMax=128M
CPUQuota=50%
TasksMax=32
[Install]
WantedBy=multi-user.target
`,
  };
  const commands = {};
  for (const c of [main, witness]) {
    const role = c.role;
    commands[role] = certificateCommands(c, role === "main" ? mainWebroot : witnessWebroot);
    files[`${role}-renewal.json`] = JSON.stringify(c, null, 2) + "\n";
    files[`${role}-certbot.ini`] = `# Dedicated configuration; not the host-wide Certbot configuration.\nemail = ${env.ACME_EMAIL}\nagree-tos = true\n`;
    files[`imonmeets-${role}-cert-renew.service`] = renewalUnit(role, commands[role]);
    files[`imonmeets-${role}-cert-renew.timer`] = `[Unit]\nDescription=Check only IMON Meets ${role} renewal\n[Timer]\nOnCalendar=*-*-* 03,15:20:00\nRandomizedDelaySec=30m\nPersistent=true\n[Install]\nWantedBy=timers.target\n`;
  }
  return { files, plan: {
    schema: 1, status: "CANDIDATE_NOT_DEPLOYED", mainHosts, witnessHost,
    mainAcmeEndpoint: `${edge.tunnel.mainIp}:${ACME_MAIN_PORT}`,
    mainAcmeNginxListener: `127.0.0.1:${ACME_MAIN_PORT}`,
    mainAcmeRequiresApprovedBridge: true,
    allowedEdgeSource: `${edge.tunnel.localIp}/32`,
    mainWebroot, witnessWebroot, commands,
    bootstrapKeepsAppAOnMain: true,
    mainKeysStayOnMain: true, witnessKeyStaysOnEdge: true,
    configurationSha256: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)])),
    deployed: false, dnsChanged: false, certificateIssued: false, renewalAccepted: false,
    nativeNginxAccepted: false, witnessEnrolled: false, public443Accepted: false,
  } };
}
export async function writeEdgeCertificateCandidate(output, env) {
  const { files, plan } = buildEdgeCertificateCandidate(env);
  absolutePath(output);
  let created = false;
  try {
    await mkdir(output, { mode: 0o700 }); created = true;
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(output, name), data, { flag: "wx", mode: 0o600 });
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
    const p = await writeEdgeCertificateCandidate(process.argv[3], process.env);
    process.stdout.write(JSON.stringify({ status: p.status, deployed: false, dnsChanged: false }) + "\n");
  })().catch((e) => {
    process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z][A-Z0-9_]+$/.test(e.code || "") ? e.code : "GENERATION_FAILED" }) + "\n");
    process.exitCode = 1;
  });
}
