import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEdgeCertificateCandidate, writeEdgeCertificateCandidate } from "./prepare-edge-certificates.mjs";
import { buildEdgeMainCandidate } from "./prepare-edge-main-ingress.mjs";
import { renewalConfig } from "./edge-certificate-policy.mjs";
import { activateCertificate, validateCertificate } from "./renew-edge-certificate.mjs";

const mainContext = {
  node: "/usr/bin/node", codeDirectory: "/opt/imonmeets/release/scripts",
  projectDirectory: "/opt/imonmeets/runtime", projectName: "imonmeets",
  envFile: "/etc/imonmeets/private/runtime.env",
  composeFiles: ["/opt/imonmeets/runtime/compose.yml", "/opt/imonmeets/runtime/compose.public.yml", "/opt/imonmeets/runtime/compose.turn.yml"],
  turnDirectory: "/opt/imonmeets/runtime/deploy/turn-private",
};
const witnessContext = { node: "/usr/bin/node", codeDirectory: "/opt/imonmeets/witness/scripts" };
const valid = {
  EDGE_PUBLIC_IP: "93.184.216.34", VPN_PUBLIC_IP: "93.184.216.35",
  EDGE_TUNNEL_LOCAL_IP: "10.255.254.1", EDGE_MAIN_TUNNEL_IP: "10.255.254.2",
  APP_URL: "https://app.example.test", LIVEKIT_URL: "wss://rtc.example.test",
  TURN_PUBLIC_HOST: "turn.example.test", EDGE_WITNESS_HOST: "witness.example.test",
  RECORDING_ENABLED: "true", S3_PUBLIC_ENDPOINT: "https://recordings.example.test", S3_BUCKET: "imon-recordings",
  LIVEKIT_SIGNALING_AUTH_ENABLED: "true", TLS_CERT_NAME: "imonmeets-edge-main",
  EDGE_WITNESS_TLS_CERT_NAME: "imonmeets-edge-witness", EDGE_MAIN_ACME_PORT: "18080",
  EDGE_MANAGED_TLS: "true", ACME_EMAIL: "ops@example.test",
  EDGE_MAIN_RENEWAL_CONTEXT: JSON.stringify(mainContext), EDGE_WITNESS_RENEWAL_CONTEXT: JSON.stringify(witnessContext),
  ORIGIN_PROXY_SECRET: "synthetic-private-proxy-secret-20261103", LIVEKIT_SIGNALING_AUTH_SECRET: "synthetic-signaling-secret-20261103",
};
const candidate = (changes = {}) => buildEdgeCertificateCandidate({ ...valid, ...changes });
const hash = (s) => createHash("sha256").update(s).digest("hex");

test("HTTP bootstrap needs no certificate and limits challenge forwarding to the agreed source, port and main names", () => {
  const { files, plan } = candidate(); const http = files["nginx.edge-http.conf"];
  assert.equal((http.match(/listen 93\.184\.216\.34:80/g) || []).length, 6);
  assert.equal((http.match(/proxy_bind 10\.255\.254\.1;/g) || []).length, 4);
  assert.equal((http.match(/proxy_pass http:\/\/10\.255\.254\.2:18080;/g) || []).length, 4);
  assert.doesNotMatch(http, /ssl_certificate|resolver |:443;|proxy_pass https|proxy_set_header Authorization|proxy_set_header Host \$/);
  assert.match(http, /server_name _;[\s\S]*?return 404;/);
  assert.match(http, /proxy_pass_request_headers off;/);
  assert.match(http, /proxy_pass_request_body off;/);
  assert(!http.includes("location ^~ /.well-known/"), "a prefix must not mask the challenge regex");
  for (const host of [...plan.mainHosts, plan.witnessHost]) assert(http.includes(`return 308 https://${host}$request_uri;`));
  assert(plan.bootstrapKeepsAppAOnMain);
});

test("the closed ACME bridge admits only the edge and nginx stays on boot-safe loopback with static read-only files", () => {
  const conf = candidate().files["nginx.main-acme.conf"];
  assert.equal((conf.match(/listen 127\.0\.0\.1:18080/g) || []).length, 2);
  assert.match(conf, /allow 127\.0\.0\.1\/32;\n    deny all;/);
  assert(!conf.includes(valid.EDGE_MAIN_TUNNEL_IP));
  const bridge = buildEdgeMainCandidate(valid);
  assert(bridge.haproxy.includes("frontend imon_main_acme\n    bind 10.255.254.2:18080\n    acl edge_peer src 10.255.254.1/32\n    tcp-request connection reject unless edge_peer\n    default_backend imon_main_acme_loopback\nbackend imon_main_acme_loopback\n    server acme 127.0.0.1:18080 source 127.0.0.1\n"));
  assert.equal(bridge.plan.listeners.at(-1).port, 18080);
  assert(!buildEdgeMainCandidate({ ...valid, EDGE_MAIN_ACME_PORT: undefined }).haproxy.includes("18080"));
  assert.match(conf, /root \/var\/lib\/imonmeets-acme;/);
  assert.match(conf, /disable_symlinks on;/);
  assert.match(conf, /try_files \$uri =404;/);
  assert.match(conf, /real_ip_header proxy_protocol;/);
  assert.doesNotMatch(conf, /proxy_pass|:80;|0\.0\.0\.0|127\.0\.0\.1:3540|witness\.example/);
  const regex = new RegExp("^/\\.well-known/acme-challenge/[A-Za-z0-9_-]{22,128}$");
  assert(regex.test("/.well-known/acme-challenge/" + "x".repeat(43)));
  for (const uri of ["/.well-known/acme-challenge/", "/.well-known/acme-challenge/../secret", "/.well-known/acme-challenge/%2e%2e", "/.well-known/acme-challenge/" + "x".repeat(43) + "?token=secret", "/api/internal/test", "//.well-known/acme-challenge/" + "x".repeat(43)]) assert(!regex.test(uri));
});

test("witness TLS permits only its three exact raw routes and preserves bearer auth with the receiver body bound", () => {
  const { files } = candidate(); const conf = files["nginx.edge-witness-tls.conf"];
  assert.equal((conf.match(/listen 127\.0\.0\.1:8446 ssl/g) || []).length, 2);
  assert.match(conf, /ssl_reject_handshake on;/);
  assert.match(conf, /server_name _;\n    ssl_reject_handshake on;\n    ssl_protocols TLSv1.2 TLSv1.3;/);
  assert.match(conf, /client_max_body_size 36k;/);
  for (const [uri, method] of [["/health", "GET"], ["/intents", "POST"], ["/checkpoint", "POST"]]) {
    assert(conf.includes(`location = ${uri} {\n        if ($request_uri != "${uri}") { return 404; }\n        if ($request_method != ${method}) { return 405; }`));
  }
  assert.equal((conf.match(/proxy_pass http:\/\/127\.0\.0\.1:3551;/g) || []).length, 3);
  assert.equal((conf.match(/proxy_set_header Authorization \$http_authorization;/g) || []).length, 3);
  assert.match(conf, /access_log off;/); assert.match(conf, /error_log \/dev\/null crit;/);
  assert.doesNotMatch(conf, /proxy_protocol|real_ip_header|proxy_set_header Authorization "|:80;/);
  assert.match(files["imonmeets-edge-nginx.service"], /Requires=imon-meets-transport.service\nBindsTo=imon-meets-transport.service\nAfter=network-online.target imon-meets-transport.service/);
});

test("certificate lifecycle isolates each host from global Certbot hooks and keeps private keys at TLS termination", () => {
  const { files, plan } = candidate();
  for (const role of ["main", "witness"]) {
    const c = JSON.parse(files[`${role}-renewal.json`]); const commands = plan.commands[role];
    assert.equal(c.lineage, `/etc/imonmeets/acme/${role}/live/${c.certificateName}`);
    assert(commands.issue.includes("--webroot")); assert(commands.issue.includes("--no-directory-hooks"));
    assert(!commands.issue.includes("--deploy-hook")); assert(!commands.issue.includes("--nginx"));
    assert(commands.renew.includes("--cert-name")); assert(commands.renew.includes("--deploy-hook"));
    assert(!commands.renewalDryRun.includes("--deploy-hook")); assert(!commands.renewalDryRun.includes("--run-deploy-hooks"));
    assert(commands.reconcile.includes("--reconcile"));
    assert.equal((files[`imonmeets-${role}-cert-renew.service`].match(/^ExecStart=/gm) || []).length, 2);
    assert.equal(c.domains.includes("witness.example.test"), role === "witness");
  }
  assert(!/install-ops|compose restart turn|--env-file=\.env\b|\/etc\/letsencrypt\/live/.test(Object.values(files).join("\n")));
  const nginx = buildEdgeMainCandidate(valid).nginx;
  assert.match(nginx, /ssl_certificate \/etc\/imonmeets\/tls\/main\/current\/fullchain.pem;/);
  assert(!nginx.includes("witness"));
  assert.match(buildEdgeMainCandidate({ ...valid, EDGE_MANAGED_TLS: undefined }).nginx, /\/etc\/letsencrypt\/live\/imonmeets-edge-main\/fullchain.pem/);
});

test("the existing edge validation, explicit port approval and scoped runtime inputs fail closed", () => {
  for (const changes of [
    { EDGE_MAIN_ACME_PORT: undefined }, { EDGE_MAIN_ACME_PORT: "18081" }, { EDGE_MAIN_ACME_PORT: "80" },
    { EDGE_MANAGED_TLS: "false" }, { EDGE_MAIN_TUNNEL_IP: "8.8.8.8" }, { EDGE_WITNESS_HOST: "app.example.test" },
    { TLS_CERT_NAME: "../existing" }, { EDGE_WITNESS_TLS_CERT_NAME: valid.TLS_CERT_NAME },
    { ACME_EMAIL: "owner@example.test\npre-hook=evil" }, { EDGE_MAIN_RENEWAL_CONTEXT: "{}" },
    { EDGE_MAIN_RENEWAL_CONTEXT: JSON.stringify({ ...mainContext, composeFiles: ["relative.yml"] }) },
    { EDGE_MAIN_RENEWAL_CONTEXT: JSON.stringify({ ...mainContext, node: "/usr/bin/node;evil" }) },
    { EDGE_WITNESS_RENEWAL_CONTEXT: JSON.stringify({ ...witnessContext, secret: "never-copy" }) },
  ]) assert.throws(() => candidate(changes));
  const disabled = candidate({ RECORDING_ENABLED: "false" });
  assert.equal(disabled.plan.mainHosts.length, 3); assert(!disabled.files["nginx.edge-http.conf"].includes("recordings.example.test"));
});

test("candidate writer stays private, refuses replacement and records exact outputs without accepting deployment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "imon-acme-write-"));
  try {
    const dest = path.join(dir, "candidate"); const plan = await writeEdgeCertificateCandidate(dest, valid);
    assert.equal((await fs.stat(dest)).mode & 0o777, 0o700);
    for (const [name, expected] of Object.entries(plan.configurationSha256)) {
      assert.equal(hash(await fs.readFile(path.join(dest, name))), expected);
      assert.equal((await fs.stat(path.join(dest, name))).mode & 0o777, 0o600);
    }
    for (const key of ["deployed", "dnsChanged", "certificateIssued", "renewalAccepted", "nativeNginxAccepted", "witnessEnrolled", "public443Accepted"]) assert.equal(plan[key], false);
    await assert.rejects(writeEdgeCertificateCandidate(dest, valid), /OUTPUT_EXISTS_OR_INVALID/);
    await fs.symlink(dest, path.join(dir, "link"));
    await assert.rejects(writeEdgeCertificateCandidate(path.join(dir, "link"), valid), /OUTPUT_EXISTS_OR_INVALID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

function native(argv, options = {}) {
  const p = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 10_000, ...options });
  assert.equal(p.status, 0, "fixture subprocess failed: " + (p.stderr?.match(/^Error: .+$/m)?.[0] || p.stderr?.slice(0, 200))); return p.stdout;
}
const certificateCache = new Map();
async function certificate(domains, serial) {
  const cacheKey = domains.join() + serial;
  if (certificateCache.has(cacheKey)) return certificateCache.get(cacheKey);
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "imon-acme-cert-"));
  try {
    native(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-set_serial", String(serial),
      "-subj", `/CN=${domains[0]}`, "-addext", "subjectAltName=" + domains.map((x) => "DNS:" + x).join(","),
      "-keyout", path.join(d, "key"), "-out", path.join(d, "cert")]);
    const result = { cert: await fs.readFile(path.join(d, "cert")), key: await fs.readFile(path.join(d, "key")) };
    certificateCache.set(cacheKey, result); return result;
  } finally { await fs.rm(d, { recursive: true, force: true }); }
}
async function fixture(role) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imon-acme-renew-"));
  const project = path.join(root, "project"); await fs.mkdir(project);
  const code = path.join(project, "code"); await fs.mkdir(code, { mode: 0o700 });
  await fs.writeFile(path.join(code, "prepare-turn.mjs"), await fs.readFile(new URL("./prepare-turn.mjs", import.meta.url)), { mode: 0o644 });
  const context = { node: process.execPath, codeDirectory: code, ...(role === "main" ? {
    projectDirectory: project, projectName: "imon-fixture", envFile: path.join(project, "runtime.env"),
    composeFiles: [path.join(project, "compose.yml")], turnDirectory: path.join(project, "turn"),
  } : {}) };
  const domains = role === "main" ? ["app.example.test", "rtc.example.test", "recordings.example.test", "turn.example.test"] : ["witness.example.test"];
  const config = renewalConfig(role, "fixture-" + role, domains, context);
  // This scratch runtime maps only UID/GID 0. Exercise the unchanged generator's
  // certificate/configuration logic as its supported non-root owner, without
  // claiming OS chown or container ownership acceptance. CI non-root needs no shim.
  let ownershipShim;
  if (process.getuid() === 0 && role === "main") {
    ownershipShim = path.join(project, "fixture-owner.mjs");
    await fs.writeFile(ownershipShim, "process.getuid = () => 12345; process.getgid = () => 12345;\n", { mode: 0o600 });
  }
  const prepareNative = (argv, options) => native(ownershipShim ? [argv[0], "--import", ownershipShim, ...argv.slice(1)] : argv, options);
  const lineage = path.join(root, config.lineage); await fs.mkdir(lineage, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(path.join(root, config.store)), { recursive: true, mode: 0o700 });
  const old = await certificate(domains, 101); const next = await certificate(domains, 102);
  const put = async (v) => { for (const [name, bytes] of [["fullchain.pem", v.cert], ["privkey.pem", v.key]]) await fs.writeFile(path.join(lineage, name), bytes, { mode: 0o600 }); };
  await put(old);
  const commands = [];
  const run = (argv, options) => {
    commands.push(argv);
    if (argv[0] === context.node) return prepareNative(argv, options);
    if (argv.includes("config")) return JSON.stringify({ name: context.projectName, services: { turn: {
      user: `${process.getuid()}:${process.getgid()}`, network_mode: "host", volumes: [{ type: "bind", source: context.turnDirectory, target: "/run/imon-turn", read_only: true }],
    } } });
    if (argv.includes("ps")) return "a".repeat(64) + "\n";
    if (argv.includes("inspect")) return JSON.stringify([{ Id: "a".repeat(64), State: { Running: true },
      Config: { User: `${process.getuid()}:${process.getgid()}`, Labels: { "com.docker.compose.project": context.projectName, "com.docker.compose.service": "turn" } },
      HostConfig: { NetworkMode: "host" }, Mounts: [{ Type: "bind", Source: context.turnDirectory, Destination: "/run/imon-turn", RW: false }],
    }]);
    return "";
  };
  const invoke = (opts = {}) => activateCertificate(config, { lineage: config.lineage, run, filesystemRoot: root, ...opts });
  const initial = await invoke({ initial: true }); assert.equal(initial.status, "INITIAL_SNAPSHOT_STAGED"); assert.equal(commands.length, 0);
  const store = path.join(root, config.store); const previous = await fs.readlink(path.join(store, "current"));
  if (role === "main") {
    const uid = process.getuid() || 12345, gid = process.getgid() || 12345;
    await fs.writeFile(context.envFile, `LIVEKIT_PUBLIC_IP=93.184.216.35\nTURN_INGRESS_443=true\nTURN_PUBLIC_HOST=turn.example.test\nTURN_SHARED_SECRET=fixture-turn-private-secret-20261103\nTLS_CERT_NAME=fixture-main\nTURN_UID=${uid}\nTURN_GID=${gid}\n`, { mode: 0o600 });
    await fs.writeFile(context.composeFiles[0], "services: {}\n");
    prepareNative([context.node, `--env-file=${context.envFile}`, path.join(code, "prepare-turn.mjs"), "--cert-only"], {
      cwd: project, env: { PATH: process.env.PATH, TURN_OUTPUT_DIR: context.turnDirectory, TURN_CERTIFICATE_DIR: lineage },
    });
  }
  await put(next);
  return { root, config, context, old, next, put, store, previous, commands, run, invoke,
    cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("certificate checks reject wrong SAN, extra names, mismatched key and expired material", async () => {
  const a = await certificate(["witness.example.test"], 201), b = await certificate(["other.example.test"], 202);
  assert.equal(validateCertificate(a.cert, a.key, ["witness.example.test"]).certificateSha256, hash(a.cert));
  assert.throws(() => validateCertificate(a.cert, b.key, ["witness.example.test"]), /CERTIFICATE_KEY_MISMATCH/);
  assert.throws(() => validateCertificate(a.cert, a.key, ["other.example.test"]), /CERTIFICATE_HOST_MISMATCH/);
  const extra = await certificate(["witness.example.test", "extra.example.test"], 203);
  assert.throws(() => validateCertificate(extra.cert, extra.key, ["witness.example.test"]), /CERTIFICATE_SAN_SET_MISMATCH/);
  assert.throws(() => validateCertificate(a.cert, a.key, ["witness.example.test"], Date.now() + 10 * 86400_000), /CERTIFICATE_NOT_CURRENT/);
});

test("foreign renewal events and repeated bootstrap never mutate the active witness snapshot", async () => {
  const f = await fixture("witness");
  try {
    assert.equal((await f.invoke({ lineage: "/etc/letsencrypt/live/meets-imon-world" })).status, "SKIPPED_FOREIGN_LINEAGE");
    assert.equal(f.commands.length, 0);
    await assert.rejects(f.invoke({ initial: true }), /INITIAL_SNAPSHOT_EXISTS/);
    assert.equal(await fs.readlink(path.join(f.store, "current")), f.previous);
  } finally { await f.cleanup(); }
});

test("witness renewal switches a verified snapshot and reloads only its dedicated TLS service", async () => {
  const f = await fixture("witness");
  try {
    assert.equal((await f.invoke()).status, "SCOPED_RENEWAL_ACTIVATED");
    assert.deepEqual(f.commands, [["/usr/sbin/nginx", "-t", "-c", "/etc/imonmeets/edge-nginx/nginx.conf"], ["/usr/bin/systemctl", "reload", "imonmeets-edge-nginx.service"]]);
    assert((await fs.readFile(path.join(f.store, "current/fullchain.pem"))).equals(f.next.cert));
    assert((await fs.readFile(path.join(f.store, f.previous, "fullchain.pem"))).equals(f.old.cert));
    const before = f.commands.length;
    assert.equal((await f.invoke()).status, "ACTIVE_CERTIFICATE_UNCHANGED");
    assert.equal(f.commands.length, before);
  } finally { await f.cleanup(); }
});

test("a directory fsync failure after publication cannot leave a dangling current or lose the prior snapshot", async () => {
  for (const initial of [false, true]) {
    const f = await fixture("witness");
    try {
      if (initial) {
        await fs.unlink(path.join(f.store, "current"));
        await fs.rm(path.join(f.store, "versions"), { recursive: true });
      }
      let failed = false; const calls = [];
      await assert.rejects(f.invoke({ initial, durableDirectory: async (dir) => {
        calls.push(dir);
        if (dir === f.store && !failed) { failed = true; throw new Error("directory fsync fixture failure"); }
        const h = await fs.open(dir, "r"); try { await h.sync(); } finally { await h.close(); }
      } }), /directory fsync fixture failure/);
      assert(failed);
      assert(calls.indexOf(path.join(f.store, "versions")) < calls.indexOf(f.store));
      if (initial) await assert.rejects(fs.lstat(path.join(f.store, "current")), { code: "ENOENT" });
      else {
        assert.equal(await fs.readlink(path.join(f.store, "current")), f.previous);
        assert((await fs.readFile(path.join(f.store, "current/fullchain.pem"))).equals(f.old.cert));
      }
      assert.equal((await fs.readdir(path.join(f.store, "versions"))).length, initial ? 0 : 1);
      assert.equal(f.commands.length, 0);
    } finally { await f.cleanup(); }
  }
});

test("nginx parser failure restores current before any reload, and locking blocks competing renewals", async () => {
  const f = await fixture("witness");
  try {
    await fs.mkdir(path.join(f.store, ".renew-lock")); await assert.rejects(f.invoke(), /RENEWAL_ALREADY_LOCKED/); await fs.rmdir(path.join(f.store, ".renew-lock"));
    const calls = [];
    await assert.rejects(f.invoke({ run: (argv) => { calls.push(argv); throw new Error("parser fixture failure"); } }), /parser fixture failure/);
    assert.equal(calls.length, 1); assert.equal(await fs.readlink(path.join(f.store, "current")), f.previous);
  } finally { await f.cleanup(); }
});

test("main renewal reuses the real cert-only TURN generator and restarts only the explicit Compose service", async () => {
  const f = await fixture("main");
  try {
    const originalConfig = await fs.readFile(path.join(f.context.turnDirectory, "turnserver.conf"));
    assert.equal((await f.invoke()).status, "SCOPED_RENEWAL_ACTIVATED");
    assert((await fs.readFile(path.join(f.context.turnDirectory, "fullchain.pem"))).equals(f.next.cert));
    assert((await fs.readFile(path.join(f.context.turnDirectory, "turnserver.conf"))).equals(originalConfig));
    const restarts = f.commands.filter((a) => a.includes("restart")); assert.equal(restarts.length, 1);
    assert.deepEqual(restarts[0].slice(-4), ["restart", "--timeout", "10", "turn"]);
    assert(restarts[0].includes(f.context.envFile)); assert(restarts[0].includes(f.context.projectName));
    assert.deepEqual(f.commands.filter((a) => a[0] === "/usr/bin/systemctl"), [["/usr/bin/systemctl", "reload", "nginx.service"]]);
  } finally { await f.cleanup(); }
});

test("runtime environment, merged Compose or actual running container drift is refused before changing certificates", async () => {
  for (const kind of ["env", "compose", "container", "ownership"]) {
    const f = await fixture("main");
    try {
      if (kind === "env") await fs.appendFile(f.context.envFile, "TURN_PUBLIC_HOST=rtc.example.test\n");
      const run = (a, o) => {
        if (kind === "compose" && a.includes("config")) return JSON.stringify({ name: "wrong-project", services: {} });
        if (kind === "container" && a.includes("inspect")) return JSON.stringify([{ Id: "a".repeat(64), Mounts: [] }]);
        if (kind === "ownership" && a.includes("config")) { const c = JSON.parse(f.run(a, o)); c.services.turn.user = "54321:54321"; return JSON.stringify(c); }
        return f.run(a, o);
      };
      await assert.rejects(f.invoke({ run }), kind === "env" ? /TURN_RUNTIME_CONFIGURATION_DRIFT/ : kind === "compose" ? /TURN_COMPOSE_CONTEXT_MISMATCH/ : kind === "ownership" ? /TURN_DIRECTORY_OWNER_MISMATCH/ : /TURN_RUNNING_CONTAINER_DRIFT/);
      assert.equal(await fs.readlink(path.join(f.store, "current")), f.previous);
      assert((await fs.readFile(path.join(f.context.turnDirectory, "fullchain.pem"))).equals(f.old.cert));
      assert(!f.commands.some((a) => a.includes("restart")));
    } finally { await f.cleanup(); }
  }
});

test("failed TURN restart restores both old certificate copies and managed snapshot, then restarts only TURN", async () => {
  const f = await fixture("main"); let restarts = 0;
  try {
    await assert.rejects(f.invoke({ run: (a, o) => {
      if (a.includes("restart") && ++restarts === 1) { f.commands.push(a); throw new Error("restart fixture failure"); }
      return f.run(a, o);
    } }), /restart fixture failure/);
    assert.equal(restarts, 2); assert.equal(await fs.readlink(path.join(f.store, "current")), f.previous);
    assert((await fs.readFile(path.join(f.context.turnDirectory, "fullchain.pem"))).equals(f.old.cert));
    assert((await fs.readFile(path.join(f.context.turnDirectory, "privkey.pem"))).equals(f.old.key));
    assert.equal(f.commands.filter((a) => a[0] === "/usr/bin/systemctl").length, 2);
  } finally { await f.cleanup(); }
});

test("a rollback failure remains a hard failure and retains the new snapshot for operator recovery", async () => {
  const f = await fixture("witness");
  try {
    await assert.rejects(f.invoke({ run: (a) => { if (a[0] === "/usr/bin/systemctl") throw new Error("unavailable service"); return ""; } }), /RENEWAL_ROLLBACK_FAILED/);
    assert.equal((await fs.readdir(path.join(f.store, "versions"))).length, 2);
    await assert.rejects(f.invoke(), /RENEWAL_ALREADY_LOCKED/);
  } finally { await f.cleanup(); }
});
