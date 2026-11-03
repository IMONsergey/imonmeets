import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ingressConfig, renderIngress, HAPROXY_IMAGE } from "./prepare-ingress443.mjs";
import { nginxTlsLayout, renderNginxTlsContext } from "./ingress-nginx-tls.mjs";
import { buildEdgeMainCandidate, writeEdgeMainCandidate } from "./prepare-edge-main-ingress.mjs";
import { ingressSourceEvidence } from "./ingress-source-evidence.mjs";

const script = fileURLToPath(new URL("./prepare-edge-main-ingress.mjs", import.meta.url));
const sha = (value) => createHash("sha256").update(value).digest("hex");
// Synthetic fixture inputs: no interface, server, DNS or secret is discovered.
const valid = {
  EDGE_PUBLIC_IP: "93.184.216.34",
  VPN_PUBLIC_IP: "93.184.216.35",
  EDGE_TUNNEL_LOCAL_IP: "10.255.254.1",
  EDGE_MAIN_TUNNEL_IP: "10.255.254.2",
  APP_URL: "https://app.example.test",
  LIVEKIT_URL: "wss://rtc.example.test",
  TURN_PUBLIC_HOST: "turn.example.test",
  EDGE_WITNESS_HOST: "witness.example.test",
  RECORDING_ENABLED: "true",
  S3_PUBLIC_ENDPOINT: "https://recordings.example.test",
  S3_BUCKET: "imon-recordings",
  LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
  TLS_CERT_NAME: "imonmeets-commercial",
  ORIGIN_PROXY_SECRET: "synthetic-private-proxy-secret-20261103",
  LIVEKIT_SIGNALING_AUTH_SECRET: "synthetic-signaling-secret-20261103",
};
const legacy = { ...valid, INGRESS_PUBLIC_IP: valid.EDGE_PUBLIC_IP };
const candidate = (overrides = {}) => buildEdgeMainCandidate({ ...valid, ...overrides });

const baseline = JSON.parse(await readFile(new URL("./fixtures/ingress443-render-f2cb148.json", import.meta.url), "utf8"));
for (const fixture of baseline.cases) {
  test(`legacy single-host output remains byte-exact: ${fixture.name}`, () => {
    const c = ingressConfig({ ...legacy, ...fixture.overrides });
    const result = renderIngress(c, fixture.layout);
    for (const [name, hash] of Object.entries(fixture.hashes)) {
      assert.equal(sha(result[name]), hash, name);
    }
    assert.equal(sha(renderNginxTlsContext(c, nginxTlsLayout(c, fixture.layout))), fixture.tlsOnlySha256);
  });
}

function sections(configuration) {
  const result = new Map();
  let section;
  for (const text of configuration.split("\n")) {
    const line = text.trim();
    if (!line || line.startsWith("#")) continue;
    const declaration = /^(frontend|backend) (\S+)$/.exec(line);
    if (declaration) {
      section = declaration[2];
      assert(!result.has(section));
      result.set(section, []);
    } else if (section) result.get(section).push(line);
  }
  return result;
}

test("closed bridge restricts each listener to its exact edge peer before routing", () => {
  const { haproxy } = candidate();
  const table = sections(haproxy);
  for (const [front, port, back, role] of [
    ["imon_main_https", 8445, "imon_main_nginx_loopback", "nginx"],
    ["imon_main_turn", 5349, "imon_main_turn_loopback", "turn"],
  ]) {
    assert.deepEqual(table.get(front), [
      `bind ${valid.EDGE_MAIN_TUNNEL_IP}:${port}`,
      `acl edge_peer src ${valid.EDGE_TUNNEL_LOCAL_IP}/32`,
      "tcp-request connection reject unless edge_peer",
      `default_backend ${back}`,
    ]);
    assert.deepEqual(table.get(back), [`server ${role} 127.0.0.1:${port} source 127.0.0.1`]);
  }
  assert.equal(table.size, 4);
  assert(!haproxy.includes(valid.EDGE_PUBLIC_IP));
  assert(!haproxy.includes(valid.VPN_PUBLIC_IP));
  assert.doesNotMatch(haproxy, /\baccept-proxy\b|\bsend-proxy(?:-v2)?\b|\bssl\b|\btransparent\b|\busesrc\b|\bmode http\b/);
  assert.doesNotMatch(haproxy, /^\s*(?:log|option\s+tcplog|option\s+httplog)\b/m);
});

test("nginx retains exactly the accepted protected TLS blocks without a public or HTTP listener", () => {
  const { nginx } = candidate();
  const fixture = baseline.cases.find((x) => x.name === "recordings");
  assert.equal(sha(nginx), fixture.tlsOnlySha256);
  assert.deepEqual([...nginx.matchAll(/^\s*listen (.+);$/gm)].map((x) => x[1]), [
    "127.0.0.1:8445 ssl proxy_protocol default_server",
    "127.0.0.1:8445 ssl proxy_protocol",
    "127.0.0.1:8445 ssl proxy_protocol",
    "127.0.0.1:8445 ssl proxy_protocol",
  ]);
  assert.doesNotMatch(nginx, /:80\b|:443\b|acme-challenge|return 308|0\.0\.0\.0/);
  for (const ip of [valid.EDGE_PUBLIC_IP, valid.VPN_PUBLIC_IP, valid.EDGE_MAIN_TUNNEL_IP, valid.EDGE_TUNNEL_LOCAL_IP]) assert(!nginx.includes(ip));
  assert.equal((nginx.match(/set_real_ip_from 127\.0\.0\.1;/g) || []).length, 3);
  assert.doesNotMatch(nginx, /set_real_ip_from (?!127\.0\.0\.1;)/);
});

test("app internal routes, forwarded-address replacement and signaling admission are preserved", () => {
  const { nginx } = candidate();
  assert(nginx.includes("location ^~ /api/internal/ { return 404; }"));
  assert(nginx.includes("proxy_set_header X-Forwarded-For $remote_addr;"));
  assert(nginx.includes("proxy_set_header X-Real-IP $remote_addr;"));
  assert(nginx.includes('proxy_set_header Forwarded "";'));
  assert(nginx.includes('proxy_set_header X-IMON-Client-IP "";'));
  for (const uri of ["/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate"]) {
    const location = nginx.slice(nginx.indexOf(`location = ${uri} {`));
    const body = location.slice(0, location.indexOf("\n    }"));
    assert(body.includes("set $imon_livekit_query_token $arg_access_token;"));
    assert(body.includes("auth_request /_imon_livekit_admission;"));
    assert(body.includes("error_page 500 502 504 =503 @imon_signal_unavailable;"));
    assert(body.includes("proxy_read_timeout 3600s;"));
  }
  assert(nginx.includes("location = /_imon_livekit_admission {\n        internal;"));
  assert(nginx.includes("proxy_pass_request_headers off;"));
  assert(nginx.includes("proxy_set_header X-IMON-LiveKit-Token $imon_livekit_query_token;"));
});

test("signed recording requests keep original host/path/query and read-only access", () => {
  const { nginx } = candidate();
  const storage = nginx.slice(nginx.indexOf("server_name recordings.example.test;"));
  assert(storage.includes("location ^~ /imon-recordings/ {"));
  assert(storage.includes("limit_except GET { deny all; }"));
  assert(storage.includes("proxy_set_header Host $http_host;"));
  assert(storage.includes("proxy_pass http://127.0.0.1:8333;"));
  assert(!storage.includes("proxy_pass http://127.0.0.1:8333/"));
  assert(storage.includes("location / { return 404; }"));
  assert(!candidate({ RECORDING_ENABLED: "false" }).nginx.includes("recordings.example.test"));
});

test("only the two private include files contain secret values", () => {
  const { haproxy, nginx, trust, signal, plan } = candidate();
  assert(trust.includes(valid.ORIGIN_PROXY_SECRET));
  assert(signal.includes(valid.LIVEKIT_SIGNALING_AUTH_SECRET));
  assert(!trust.includes(valid.LIVEKIT_SIGNALING_AUTH_SECRET));
  assert(!signal.includes(valid.ORIGIN_PROXY_SECRET));
  for (const value of [haproxy, nginx, JSON.stringify(plan)]) {
    assert(!value.includes(valid.ORIGIN_PROXY_SECRET));
    assert(!value.includes(valid.LIVEKIT_SIGNALING_AUTH_SECRET));
  }
  assert.deepEqual(Object.keys(plan.publicConfigurationSha256).sort(), ["haproxy-main.cfg", "nginx.tls.conf"]);
});

test("plan identifies the closed contract without promoting runtime or public acceptance", () => {
  const { haproxy, nginx, plan } = candidate();
  assert.equal(plan.image, HAPROXY_IMAGE);
  assert.equal(plan.publicConfigurationSha256["haproxy-main.cfg"], sha(haproxy));
  assert.equal(plan.publicConfigurationSha256["nginx.tls.conf"], sha(nginx));
  assert.equal(plan.mainTunnelIp, valid.EDGE_MAIN_TUNNEL_IP);
  assert.equal(plan.allowedEdgeSource, valid.EDGE_TUNNEL_LOCAL_IP + "/32");
  for (const key of ["productionChanges", "deployed", "tunnelConfigured", "tunnelConfinementVerified", "listenerSourceAclProvesConfinement", "runtimeAccepted", "certificatesVerified", "dnsChanged", "public443Accepted"]) assert.equal(plan[key], false, key);
  assert.equal(plan.nginx.httpIncluded, false);
  assert.equal(plan.nginx.acmeIncluded, false);
});

test("untrusted or ambiguous tunnel endpoints are rejected before any config is written", () => {
  for (const field of ["EDGE_MAIN_TUNNEL_IP", "EDGE_TUNNEL_LOCAL_IP"]) {
    for (const value of [undefined, "", "8.8.8.8", "127.0.0.1", "0.0.0.0", "169.254.1.1", "100.64.0.1", "::1", "main.internal", "010.0.0.1", "10.0.0.1/32", "10.0.0.1\nbind 0.0.0.0:443"]) {
      assert.throws(() => candidate({ [field]: value }), (e) => e.code === `INVALID_${field}`);
    }
  }
  assert.throws(() => candidate({ EDGE_MAIN_TUNNEL_IP: valid.EDGE_TUNNEL_LOCAL_IP }), (e) => e.code === "TUNNEL_IP_COLLISION");
});

test("TLS lineage and private includes require explicit non-injectable values", () => {
  for (const value of [undefined, "", "../other", "UPPER", "fixture\nssl_verify_client off;", "a".repeat(65)]) {
    assert.throws(() => candidate({ TLS_CERT_NAME: value }), (e) => e.code === "INVALID_TLS_CERT_NAME");
  }
  for (const field of ["ORIGIN_PROXY_SECRET", "LIVEKIT_SIGNALING_AUTH_SECRET"]) {
    for (const value of [undefined, "short", "x".repeat(257), 'x";\ninclude /tmp/injection;']) {
      assert.throws(() => candidate({ [field]: value }), (e) => e.code === `INVALID_${field}`);
    }
  }
  assert.throws(() => candidate({ S3_BUCKET: "public" }), (e) => e.code === "INVALID_S3_BUCKET");
  assert.throws(() => candidate({ LIVEKIT_SIGNALING_AUTH_ENABLED: "false" }), (e) => e.code === "SIGNALING_GUARD_REQUIRED");
});

test("edge hostname uniqueness and strict origin policy also protect main TLS config", () => {
  for (const value of ["https://app.example.test:443", "https://app.example.test/path", "https://user:secret@app.example.test", "https://app.example.test\n", "https://İ.example.test"]) {
    assert.throws(() => candidate({ APP_URL: value }), (e) => e.code === "INVALID_APP_URL");
  }
  assert.throws(() => candidate({ EDGE_WITNESS_HOST: "app.example.test" }), (e) => e.code === "HOSTNAME_COLLISION");
  const upper = candidate({ APP_URL: "https://APP.EXAMPLE.TEST/" });
  assert(upper.nginx.includes("server_name app.example.test;"));
});

test("generation creates private files and writes a matching secrets-free plan last", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "imon-main-candidate-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = path.join(parent, "candidate");
  const plan = await writeEdgeMainCandidate(output, valid);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(output)).sort(), ["haproxy-main.cfg", "imonmeets-commercial-trust.conf", "imonmeets-signaling-auth.conf", "nginx.tls.conf", "plan.json"]);
  for (const name of await readdir(output)) assert.equal((await stat(path.join(output, name))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(output, "plan.json"), "utf8")), plan);
  for (const [name, hash] of Object.entries(plan.publicConfigurationSha256)) assert.equal(sha(await readFile(path.join(output, name))), hash);
});

test("existing output files, directories and symlinks remain untouched", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "imon-main-refusal-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const existingFile = path.join(parent, "existing-file");
  await writeFile(existingFile, "keep");
  const existingDir = await mkdtemp(path.join(parent, "existing-dir-"));
  await writeFile(path.join(existingDir, "sentinel"), "keep");
  const alias = path.join(parent, "alias");
  await symlink(existingDir, alias);
  for (const target of [existingFile, existingDir, alias]) {
    await assert.rejects(writeEdgeMainCandidate(target, valid), (e) => e.code === "OUTPUT_EXISTS_OR_INVALID");
  }
  assert.equal(await readFile(existingFile, "utf8"), "keep");
  assert.deepEqual(await readdir(existingDir), ["sentinel"]);
  await assert.rejects(writeEdgeMainCandidate("relative", valid), (e) => e.code === "OUTPUT_EXISTS_OR_INVALID");
});

test("invalid CLI inputs produce fixed diagnostics without leaking values or paths", () => {
  const injected = "secret-marker-unsafe-value";
  const result = spawnSync(process.execPath, [script, "--output", "/not-created-private-path"], {
    encoding: "utf8", env: { ...process.env, ...valid, ORIGIN_PROXY_SECRET: injected },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, code: "INVALID_ORIGIN_PROXY_SECRET" });
  assert(!result.stderr.includes(injected));
  assert(!result.stderr.includes("/not-created-private-path"));
});

test("source evidence records the imported TLS helper and detects its independent modification", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "imon-renderer-evidence-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const entry = path.join(parent, "prepare-ingress443.mjs");
  const helper = path.join(parent, "ingress-nginx-tls.mjs");
  const entryBytes = await readFile(new URL("./prepare-ingress443.mjs", import.meta.url));
  const helperBytes = await readFile(new URL("./ingress-nginx-tls.mjs", import.meta.url));
  await writeFile(entry, entryBytes);
  await writeFile(helper, helperBytes);
  const first = ingressSourceEvidence(entry);
  assert.equal(first.generatorSha256, sha(entryBytes));
  assert.equal(first.generatorLayout, "shared-tls-renderer");
  assert.deepEqual(first.generatorDependenciesSha256, { "ingress-nginx-tls.mjs": sha(helperBytes) });
  await writeFile(helper, Buffer.concat([helperBytes, Buffer.from("\n// fixture change\n")]));
  const second = ingressSourceEvidence(entry);
  assert.equal(second.generatorSha256, first.generatorSha256);
  assert.notDeepEqual(second.generatorDependenciesSha256, first.generatorDependenciesSha256);
  await rm(helper);
  assert.throws(() => ingressSourceEvidence(entry));
});

test("historical monolithic generator overrides do not acquire a fictitious helper dependency", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "imon-monolithic-evidence-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const entry = path.join(parent, "historical-generator.mjs");
  const content = 'import path from "node:path";\nexport const fixture = true;\n';
  await writeFile(entry, content);
  const result = ingressSourceEvidence(entry);
  assert.equal(result.generatorSha256, sha(content));
  assert.equal(result.generatorLayout, "legacy-monolithic");
  assert.deepEqual(result.generatorDependenciesSha256, {});
});
