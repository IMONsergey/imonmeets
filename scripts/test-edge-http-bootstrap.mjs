import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEdgeCertificateCandidate } from "./prepare-edge-certificates.mjs";
import { buildEdgeHttpBootstrapCandidate, writeEdgeHttpBootstrapCandidate } from "./prepare-edge-http-bootstrap.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const baseline = JSON.parse(await fs.readFile(new URL("./fixtures/edge-certificates-05cc907.json", import.meta.url), "utf8"));
assert.equal(baseline.sourceCommit, "05cc907784afe09c156026cc822d3f6bf08bd4c3");
assert.equal(baseline.generatorSha256, "0d08764c46646deeb04a1d8c01180e4d290243f420e5faff57105f2aedcbf142");
const publicKeys = ["EDGE_PUBLIC_IP", "VPN_PUBLIC_IP", "EDGE_TUNNEL_LOCAL_IP", "EDGE_MAIN_TUNNEL_IP", "APP_URL", "LIVEKIT_URL", "TURN_PUBLIC_HOST", "EDGE_WITNESS_HOST", "RECORDING_ENABLED", "S3_PUBLIC_ENDPOINT", "LIVEKIT_SIGNALING_AUTH_ENABLED", "EDGE_MAIN_ACME_PORT"];
const valid = Object.fromEntries(publicKeys.map((k) => [k, baseline.baseEnv[k]]));
const candidate = (overrides = {}) => buildEdgeHttpBootstrapCandidate({ ...valid, ...overrides });
const script = fileURLToPath(new URL("./prepare-edge-http-bootstrap.mjs", import.meta.url));

for (const fixture of baseline.cases) {
  test(`full certificate candidate stays byte-exact to 05cc: ${fixture.name}`, () => {
    const full = buildEdgeCertificateCandidate({ ...baseline.baseEnv, ...fixture.overrides });
    assert.deepEqual(Object.keys(full.files), Object.keys(fixture.filesSha256));
    for (const [name, expected] of Object.entries(fixture.filesSha256)) assert.equal(sha(full.files[name]), expected, name);
    assert.equal(sha(JSON.stringify(full.plan)), fixture.planSha256, "entire full plan");
    const only = candidate(fixture.overrides);
    assert.equal(only.files["nginx.edge-http.conf"], full.files["nginx.edge-http.conf"]);
  });
}

test("HTTP-only generation does not require or access certificate, secret or runtime-context inputs", () => {
  const inputs = { ...valid };
  for (const key of ["TLS_CERT_NAME", "EDGE_WITNESS_TLS_CERT_NAME", "EDGE_MANAGED_TLS", "ACME_EMAIL", "EDGE_MAIN_RENEWAL_CONTEXT", "EDGE_WITNESS_RENEWAL_CONTEXT", "ORIGIN_PROXY_SECRET", "LIVEKIT_SIGNALING_AUTH_SECRET"]) {
    Object.defineProperty(inputs, key, { get() { assert.fail(`HTTP-only accessed ${key}`); } });
  }
  const { files, plan } = buildEdgeHttpBootstrapCandidate(inputs);
  assert.deepEqual(Object.keys(files).sort(), ["imonmeets-edge-http-bootstrap.service", "imonmeets-main-acme-bootstrap.service", "nginx.edge-http.conf", "nginx.edge.conf", "nginx.main-http.conf", "nginx.main.conf"]);
  assert(!Object.hasOwn(plan, "commands"));
  assert.equal(plan.privateInputsRequired, false);
  assert.equal(plan.runtimeContextsRequired, false);
  assert.doesNotMatch(Object.values(files).join("\n"), /ssl_certificate|\bssl\b|\/tls\/|\.pem|certbot|renew-edge|--deploy-hook|\/api\/|:8445|:5349|:8446|:3551/);
});

test("dedicated main serves only exact raw challenge paths to the actual private peer, without inherited address trust", () => {
  const { files, plan } = candidate();
  const conf = files["nginx.main-http.conf"];
  assert.deepEqual([...conf.matchAll(/^\s*listen (.+);$/gm)].map((m) => m[1]), ["10.255.254.2:18080 default_server", "10.255.254.2:18080"]);
  assert.equal((conf.match(/if \(\$remote_addr != "10\.255\.254\.1"\) \{ return 403; \}/g) || []).length, 2);
  const challenge = conf.slice(conf.indexOf('    location ~ "^/'));
  assert.match(challenge, /if \(\$request_uri !~ "\^\/\\\.well-known\/acme-challenge\/\[A-Za-z0-9_-\]\{22,128\}\$"\) \{ return 404; \}/);
  assert.match(challenge, /if \(\$request_method !~ "\^\(GET\|HEAD\)\$"\) \{ return 405; \}/);
  assert.match(challenge, /allow 10\.255\.254\.1\/32;\n        deny all;\n        root \/var\/lib\/imonmeets-acme;/);
  assert.match(challenge, /disable_symlinks on;/);
  assert.match(challenge, /try_files \$uri =404;/);
  assert.match(conf, /location \/ \{ return 404; \}/);
  assert.doesNotMatch(conf, /proxy_pass|proxy_protocol|real_ip|Forwarded|Authorization|include |0\.0\.0\.0|127\.0\.0\.1|:80\b/);
  assert.equal(plan.mainAcmePortOwner, "imonmeets-main-acme-bootstrap.service");
  assert.equal(plan.handoff.bridgeCannotStartConcurrently, true);
});

test("edge preserves fixed-Host source-bound HTTP proxy and local witness challenge boundary", () => {
  const { files, plan } = candidate(); const conf = files["nginx.edge-http.conf"];
  assert.equal((conf.match(/proxy_bind 10\.255\.254\.1;/g) || []).length, 4);
  assert.equal((conf.match(/proxy_pass http:\/\/10\.255\.254\.2:18080;/g) || []).length, 4);
  assert.equal((conf.match(/proxy_pass_request_headers off;/g) || []).length, 4);
  assert.equal((conf.match(/proxy_pass_request_body off;/g) || []).length, 4);
  for (const host of plan.mainHosts) assert(conf.includes(`proxy_set_header Host ${host};`));
  const witness = conf.slice(conf.indexOf("server_name witness.example.test;"));
  assert.match(witness, /root \/var\/lib\/imonmeets-witness-acme;/);
  assert.doesNotMatch(witness, /proxy_pass|proxy_bind/);
  assert.doesNotMatch(conf, /location \^~ \/\.well-known\/|resolver |proxy_set_header Host \$/);
  const disabled = candidate({ RECORDING_ENABLED: "false" });
  assert(!disabled.files["nginx.main-http.conf"].includes("recordings.example.test"));
  assert(!disabled.files["nginx.edge-http.conf"].includes("recordings.example.test"));
});

test("native units own only their standalone foreground nginx, require transport and have bounded privileges", () => {
  const { files } = candidate();
  for (const [role, unit] of [["main", "imonmeets-main-acme-bootstrap"], ["edge", "imonmeets-edge-http-bootstrap"]]) {
    const service = files[`${unit}.service`], conf = files[`nginx.${role}.conf`];
    assert.match(service, /Requires=imon-meets-transport.service\nBindsTo=imon-meets-transport.service\nAfter=network-online.target imon-meets-transport.service/);
    assert.match(service, /Type=simple\nUser=www-data\nGroup=www-data/);
    assert(service.includes(`RuntimeDirectory=${unit}\nRuntimeDirectoryMode=0700`));
    assert(service.includes(`ExecStart=/usr/sbin/nginx -p /run/${unit}/ -e stderr -c /etc/imonmeets-http-bootstrap/${role}/nginx.conf -g "daemon off;"`));
    assert(service.includes(`PIDFile=/run/${unit}/nginx.pid`));
    assert.match(service, /KillSignal=SIGQUIT\nKillMode=mixed\nTimeoutStopSec=15\nRestart=no/);
    assert.match(service, /NoNewPrivileges=true/);
    assert.match(service, /ProtectSystem=strict/);
    assert.match(service, /MemoryMax=128M\nCPUQuota=50%\nTasksMax=32/);
    assert.doesNotMatch(service, /ExecReload|ExecStop=|ExecStartPre|nginx -s|systemctl|docker|sudo|nginx\.service|CAP_NET_ADMIN/);
    const cap = role === "edge" ? "CAP_NET_BIND_SERVICE" : "";
    assert(service.includes(`CapabilityBoundingSet=${cap}\nAmbientCapabilities=${cap}\n`));
    assert(conf.includes(`pid /run/${unit}/nginx.pid;`));
    assert.match(conf, /error_log stderr crit;/);
    for (const directive of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]) assert(conf.includes(`${directive}_temp_path /run/${unit}/`));
    assert.deepEqual([...conf.matchAll(/^\s*include (.+);$/gm)].map((m) => m[1]), [`/etc/imonmeets-http-bootstrap/${role}/http.conf`]);
    assert.doesNotMatch(conf, /\*|user |\/etc\/nginx|\/var\/lib\/nginx|\/tls\//);
  }
});

test("HTTP-only retains strict public topology validation and explicit approved ACME port", () => {
  for (const overrides of [
    { EDGE_MAIN_ACME_PORT: undefined }, { EDGE_MAIN_ACME_PORT: "8445" }, { EDGE_MAIN_ACME_PORT: "18081" },
    { EDGE_MAIN_TUNNEL_IP: "127.0.0.1" }, { EDGE_MAIN_TUNNEL_IP: "8.8.8.8" },
    { EDGE_TUNNEL_LOCAL_IP: "10.0.0.1/32" }, { EDGE_TUNNEL_LOCAL_IP: valid.EDGE_MAIN_TUNNEL_IP },
    { EDGE_PUBLIC_IP: valid.VPN_PUBLIC_IP }, { EDGE_PUBLIC_IP: "0.0.0.0" },
    { APP_URL: "https://app.example.test:443" }, { APP_URL: "https://app.example.test/path" },
    { EDGE_WITNESS_HOST: "app.example.test" }, { TURN_PUBLIC_HOST: "turn.example.test;\ninclude /tmp/untrusted;" },
    { LIVEKIT_SIGNALING_AUTH_ENABLED: "false" }, { RECORDING_ENABLED: "1" },
  ]) assert.throws(() => candidate(overrides));
});

test("private staging, readable installed-mode contract and unaccepted runtime flags stay explicit", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "imon-http-bootstrap-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dest = path.join(parent, "candidate"); const plan = await writeEdgeHttpBootstrapCandidate(dest, valid);
  assert.equal((await fs.stat(dest)).mode & 0o777, 0o700);
  assert.deepEqual((await fs.readdir(dest)).sort(), [...Object.keys(plan.configurationSha256), "plan.json"].sort());
  for (const [name, hash] of Object.entries(plan.configurationSha256)) {
    assert.equal(sha(await fs.readFile(path.join(dest, name))), hash);
    assert.equal((await fs.stat(path.join(dest, name))).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(path.join(dest, "plan.json"))).mode & 0o777, 0o600);
  for (const role of ["main", "edge"]) {
    assert.equal(plan.install[role].configurationOwner, "root:root");
    assert.equal(plan.install[role].configurationFileMode, "0644");
    assert.equal(plan.install[role].configurationDirectoryMode, "0755");
  }
  assert.deepEqual(plan.configurationParent, { path: "/etc/imonmeets-http-bootstrap", owner: "root:root", mode: "0755" });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dest, "plan.json"), "utf8")), plan);
  for (const key of ["productionChanges", "deployed", "dnsChanged", "applicationReleaseChanged", "nativeNginxAccepted", "serviceLifecycleAccepted", "httpChallengeAccepted", "certificateIssued", "renewalAccepted", "witnessEnrolled", "public443Accepted"]) assert.equal(plan[key], false, key);
  assert(plan.nginxConfigTestCanBind);
  assert(plan.handoff.startConsumersExplicitlyAfterTransportRecovery);
  await assert.rejects(writeEdgeHttpBootstrapCandidate(dest, valid), /OUTPUT_EXISTS_OR_INVALID/);
  const existing = path.join(parent, "operator.txt"); await fs.writeFile(existing, "preserve");
  await assert.rejects(writeEdgeHttpBootstrapCandidate(existing, valid), /OUTPUT_EXISTS_OR_INVALID/);
  assert.equal(await fs.readFile(existing, "utf8"), "preserve");
  const link = path.join(parent, "link"); await fs.symlink(dest, link);
  await assert.rejects(writeEdgeHttpBootstrapCandidate(link, valid), /OUTPUT_EXISTS_OR_INVALID/);
});

test("CLI emits only bounded status and rejects invalid input without private values or path echo", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "imon-http-cli-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const secret = "synthetic-private-value-never-output";
  const env = { PATH: process.env.PATH, ...valid, ORIGIN_PROXY_SECRET: secret, EDGE_MAIN_RENEWAL_CONTEXT: "invalid-unused-private-context" };
  const good = spawnSync(process.execPath, [script, "--output", path.join(parent, "candidate")], { env, encoding: "utf8" });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).mode, "native-http-bootstrap-only");
  assert(!good.stdout.includes(secret)); assert(!good.stdout.includes(parent));
  const bad = spawnSync(process.execPath, [script, "--output", path.join(parent, "invalid")], { env: { ...env, APP_URL: "https://" + secret + "/invalid" }, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).code, "INVALID_APP_URL");
  assert(!bad.stderr.includes(secret));
  await assert.rejects(fs.stat(path.join(parent, "invalid")), { code: "ENOENT" });
});
