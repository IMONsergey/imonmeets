import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildEdgeVpsCandidate,
  writeEdgeVpsCandidate,
} from "./prepare-edge-vps-ingress.mjs";
import { HAPROXY_IMAGE } from "./prepare-ingress443.mjs";

const script = fileURLToPath(
  new URL("./prepare-edge-vps-ingress.mjs", import.meta.url),
);
// Fixture addresses are never assigned, contacted or used to open sockets.
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
  LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
};

function candidate(overrides = {}) {
  return buildEdgeVpsCandidate({ ...valid, ...overrides });
}

function rejects(overrides, code) {
  assert.throws(
    () => candidate(overrides),
    (e) => e.code === code,
  );
}

// Inspect the actual emitted routing table, independently of the generator's
// plan. This is a static oracle, not a HAProxy parser or a TLS acceptance test.
function inspect(text) {
  const lines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  const acls = new Map();
  const routes = [];
  const servers = new Map();
  let section;
  for (const line of lines) {
    let match;
    if ((match = /^(?:frontend|backend) (\S+)$/.exec(line))) section = match[1];
    if ((match = /^acl (\S+) req\.ssl_sni -i (.+)$/.exec(line))) {
      assert(!acls.has(match[1]), "duplicate ACL");
      acls.set(match[1], match[2].split(/\s+/));
    }
    if ((match = /^use_backend (\S+) if (\S+)$/.exec(line))) {
      routes.push({ backend: match[1], acl: match[2] });
    }
    if ((match = /^server (\S+) (\S+)(.*)$/.exec(line))) {
      assert(
        !servers.has(section),
        "multiple/fallback servers are not permitted",
      );
      const options = match[3].trim().split(/\s+/).filter(Boolean);
      servers.set(section, {
        endpoint: match[2],
        proxyV2: options.includes("send-proxy-v2"),
        source: options.includes("source")
          ? options[options.indexOf("source") + 1]
          : null,
        options,
      });
    }
  }
  const route = (sni) => {
    if (typeof sni !== "string") return null;
    const matching = routes.filter((r) =>
      acls.get(r.acl)?.includes(sni.toLowerCase()),
    );
    assert(matching.length <= 1, "overlapping routes");
    return matching.length ? servers.get(matching[0].backend) : null;
  };
  return { lines, acls, routes, servers, route };
}

test("each allowed SNI reaches its intended endpoint and wire format", () => {
  const { haproxy } = candidate();
  const table = inspect(haproxy);
  for (const name of ["app", "rtc", "recordings"]) {
    const target = table.route(`${name}.example.test`);
    assert.equal(target?.endpoint, `${valid.EDGE_MAIN_TUNNEL_IP}:8445`);
    assert.equal(target.proxyV2, true);
    assert.equal(target.source, valid.EDGE_TUNNEL_LOCAL_IP);
  }
  const turn = table.route("turn.example.test");
  assert.equal(turn?.endpoint, `${valid.EDGE_MAIN_TUNNEL_IP}:5349`);
  assert.equal(turn.proxyV2, false);
  assert.equal(turn.source, valid.EDGE_TUNNEL_LOCAL_IP);
  const witness = table.route("witness.example.test");
  assert.equal(witness?.endpoint, "127.0.0.1:8446");
  assert.equal(witness.proxyV2, false);
  assert.equal(witness.source, null);
  assert.equal(table.servers.size, 3);
  assert.deepEqual(
    table.lines.filter((s) => s.startsWith("bind ")),
    [`bind ${valid.EDGE_PUBLIC_IP}:443`],
  );
  assert(!haproxy.includes(valid.VPN_PUBLIC_IP));
  for (const target of table.servers.values()) {
    assert(
      !target.options.includes("ssl"),
      "passthrough must not add another TLS layer",
    );
    assert(
      !target.options.includes("send-proxy"),
      "PROXY v1 is outside this contract",
    );
  }
});

test("foreign, missing, suffix-confused SNI has no fallback route", () => {
  const table = inspect(candidate().haproxy);
  for (const host of [
    undefined,
    "",
    "foreign.example.test",
    "app.example.test.attacker.test",
    "example.test",
    "APP.EXAMPLE.TEST.",
  ]) {
    assert.equal(table.route(host), null);
  }
  assert.equal(
    table.route("APP.EXAMPLE.TEST")?.endpoint,
    `${valid.EDGE_MAIN_TUNNEL_IP}:8445`,
  );
  assert(!table.lines.some((s) => s.startsWith("default_backend ")));
  assert(!table.lines.some((s) => s.startsWith("default-server ")));
  assert(table.lines.includes("tcp-request inspect-delay 5s"));
  const reject = table.lines.indexOf(
    "tcp-request content reject if { req.ssl_hello_type 1 } !known_sni",
  );
  const accept = table.lines.indexOf(
    "tcp-request content accept if { req.ssl_hello_type 1 } known_sni",
  );
  const deadline = table.lines.indexOf(
    "tcp-request content reject if WAIT_END",
  );
  assert(reject >= 0 && accept > reject && deadline > accept);
  assert(table.lines.includes("mode tcp"));
  assert(
    !table.lines.some((s) =>
      /\baccept-proxy\b|^mode http$|^log |^option (?:http|tcp)log\b/.test(s),
    ),
  );
});

test("disabled recording removes its name from both admission and routes", () => {
  const { haproxy, plan } = candidate({ RECORDING_ENABLED: "false" });
  const table = inspect(haproxy);
  assert.equal(table.route("recordings.example.test"), null);
  assert(!table.acls.get("known_sni")?.includes("recordings.example.test"));
  assert(!JSON.stringify(plan).includes("recordings.example.test"));
  assert(table.route("witness.example.test"));
});

test("plan describes the same routing while keeping all runtime gates unaccepted", () => {
  const { haproxy, plan } = candidate();
  assert.equal(plan.status, "CANDIDATE_NOT_DEPLOYED");
  assert.equal(plan.image, HAPROXY_IMAGE);
  assert.equal(
    plan.haproxySha256,
    createHash("sha256").update(haproxy).digest("hex"),
  );
  assert.equal(plan.preservedVpnIp, valid.VPN_PUBLIC_IP);
  for (const field of [
    "productionChanges",
    "deployed",
    "tunnelConfigured",
    "tunnelConfinementVerified",
    "dnsChanged",
    "certificatesVerified",
    "httpAcmeIncluded",
    "witnessEnrolled",
    "externalMediaAccepted",
    "public443Accepted",
  ]) {
    assert.equal(plan[field], false, field);
  }
  const table = inspect(haproxy);
  assert.equal(plan.routes.length, 5);
  for (const r of plan.routes) {
    const actual = table.route(r.sni);
    assert(actual);
    assert.equal(r.endpoint, actual.endpoint);
    assert.equal(r.proxyProtocol, actual.proxyV2 ? "v2" : "none");
  }
  assert.equal(plan.tunnel.sourceBindingProvesConfinement, false);
});

test("missing explicit network inputs fail closed", () => {
  for (const name of [
    "EDGE_PUBLIC_IP",
    "VPN_PUBLIC_IP",
    "EDGE_TUNNEL_LOCAL_IP",
    "EDGE_MAIN_TUNNEL_IP",
  ]) {
    rejects({ [name]: undefined }, `INVALID_${name}`);
  }
  rejects({ EDGE_PUBLIC_IP: valid.VPN_PUBLIC_IP }, "PUBLIC_IP_COLLISION");
  rejects(
    { EDGE_MAIN_TUNNEL_IP: valid.EDGE_TUNNEL_LOCAL_IP },
    "TUNNEL_IP_COLLISION",
  );
});

test("both tunnel endpoints reject public and every non-RFC1918 address class", () => {
  const forbidden = [
    "8.8.8.8",
    "127.0.0.1",
    "127.5.6.7",
    "0.0.0.0",
    "0.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.254",
    "172.15.1.2",
    "172.32.1.2",
    "192.0.2.20",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "fd00::1",
    "main.internal",
    "10.0.0.1:8445",
    "10.0.0.1/32",
    "010.0.0.1",
    "0x0a000001",
    "167772161",
    "10.0.0.1\nserver injected 8.8.8.8:443",
  ];
  for (const field of ["EDGE_MAIN_TUNNEL_IP", "EDGE_TUNNEL_LOCAL_IP"]) {
    for (const value of forbidden)
      rejects({ [field]: value }, `INVALID_${field}`);
  }
});

test("RFC1918 validation accepts all three private ranges without discovering routes", () => {
  for (const [local, main] of [
    ["10.0.0.1", "10.255.255.254"],
    ["172.16.0.1", "172.31.255.254"],
    ["192.168.0.1", "192.168.255.254"],
  ]) {
    const { plan } = candidate({
      EDGE_TUNNEL_LOCAL_IP: local,
      EDGE_MAIN_TUNNEL_IP: main,
    });
    assert.equal(plan.tunnel.localIp, local);
    assert.equal(plan.tunnel.mainIp, main);
    assert.equal(plan.tunnelConfinementVerified, false);
  }
});

test("public bind and preserved VPN inputs reject special-purpose and alternate numeric spellings", () => {
  for (const field of ["EDGE_PUBLIC_IP", "VPN_PUBLIC_IP"]) {
    for (const value of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.0.9",
      "192.0.2.20",
      "192.88.99.2",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "93.184.216.034",
      "93.184.216.34:443",
      "93.184.216.34\n",
      "0x5db8d822",
      "edge.example.test",
    ]) {
      rejects({ [field]: value }, `INVALID_${field}`);
    }
  }
});

test("SNI names are normalized before cross-role collision checks", () => {
  const { haproxy } = candidate({
    TURN_PUBLIC_HOST: "TURN.Example.TEST",
    EDGE_WITNESS_HOST: "WITNESS.EXAMPLE.TEST",
  });
  assert(inspect(haproxy).route("turn.example.test"));
  rejects({ EDGE_WITNESS_HOST: "APP.EXAMPLE.TEST" }, "HOSTNAME_COLLISION");
  rejects({ TURN_PUBLIC_HOST: "RTC.EXAMPLE.TEST" }, "HOSTNAME_COLLISION");
  rejects(
    { S3_PUBLIC_ENDPOINT: "https://witness.EXAMPLE.test" },
    "HOSTNAME_COLLISION",
  );
  rejects({ LIVEKIT_URL: "wss://APP.example.test" }, "HOSTNAME_COLLISION");
});

test("unsafe SNI input cannot inject configuration or broaden the allowlist", () => {
  for (const field of ["TURN_PUBLIC_HOST", "EDGE_WITNESS_HOST"]) {
    for (const value of [
      undefined,
      "",
      "*.example.test",
      "turn.example.test.",
      "127.0.0.1",
      "turn",
      "https://turn.example.test",
      "turn.example.test:443",
      "turn.example.test other.example.test",
      "turn.example.test\nacl known_sni always_true",
      "turn.example.test\r",
      "turn.example.test\0",
      "тест.example.test",
      "K.example.test",
      `${"a".repeat(64)}.example.test`,
    ]) {
      rejects({ [field]: value }, `INVALID_${field}`);
    }
  }
});

test("origins reject credentials, alternate ports, paths and URL-parser normalization tricks", () => {
  for (const field of ["APP_URL", "LIVEKIT_URL", "S3_PUBLIC_ENDPOINT"]) {
    const scheme = field === "LIVEKIT_URL" ? "wss" : "https";
    for (const value of [
      undefined,
      `${scheme}://user:password@x.example.test`,
      `${scheme}://x.example.test:8443`,
      `${scheme}://x.example.test:443`,
      `${scheme}://x.example.test/path`,
      `${scheme}://x.example.test?q=x`,
      `${scheme}://x.example.test#x`,
      ` ${scheme}://x.example.test`,
      `${scheme}://x.example.test\n`,
      `${scheme}://127.0.0.1`,
      `${scheme}://x.example.test\\path`,
      `${scheme}://K.example.test`,
      "http://x.example.test",
    ]) {
      rejects({ [field]: value }, `INVALID_${field}`);
    }
  }
});

test("recording and admission settings must be explicit", () => {
  for (const value of [undefined, "", "yes", "TRUE", true])
    rejects({ RECORDING_ENABLED: value }, "INVALID_RECORDING_ENABLED");
  for (const value of [undefined, "false", "TRUE", true])
    rejects(
      { LIVEKIT_SIGNALING_AUTH_ENABLED: value },
      "SIGNALING_GUARD_REQUIRED",
    );
});

test("unrelated environment secrets are never copied or read into outputs", () => {
  const sentinel = "secret-sentinel-not-for-generated-output";
  const env = {
    ...valid,
    ORIGIN_PROXY_SECRET: sentinel,
    TURN_SHARED_SECRET: sentinel,
    WITNESS_API_TOKEN: sentinel,
    RESEND_API_KEY: sentinel,
    PRIVATE_KEY: sentinel,
  };
  const before = { ...env };
  assert(!JSON.stringify(buildEdgeVpsCandidate(env)).includes(sentinel));
  assert.deepEqual(env, before);
});

test("standalone manifest can read root-owned 0600 config without broad container authority", async () => {
  const manifest = await readFile(
    new URL("../compose.edge-vps-ingress.yml", import.meta.url),
    "utf8",
  );
  // Regression guard: Config.User from the image must not accidentally select a
  // non-root reader for an operator-installed root-only file. Runtime startup
  // and the subsequent HAProxy privilege drop are separate acceptance gates.
  const users = [...manifest.matchAll(/^    user:\s*(.+)$/gm)].map((m) =>
    m[1].replace(/["']/g, "").trim(),
  );
  assert.equal(users.length, 1);
  assert(["0:0", "0", "root:root", "root"].includes(users[0]));
  assert.equal(manifest.match(/^    image:\s*(\S+)$/m)?.[1], HAPROXY_IMAGE);
  const capabilities = manifest
    .match(/^    cap_add:\s*\[([^\]]*)\]$/m)?.[1]
    .split(",")
    .map((s) => s.trim())
    .sort();
  assert.deepEqual(capabilities, ["NET_BIND_SERVICE", "SETGID", "SETUID"]);
  assert.match(manifest, /^    cap_drop: \[ALL\]$/m);
  assert.match(manifest, /^    profiles: \[edge-candidate\]$/m);
  assert.match(manifest, /^    restart: "no"$/m);
  const lines = inspect(candidate().haproxy).lines;
  assert(lines.includes("user haproxy") && lines.includes("group haproxy"));
});

async function inTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imon-edge-candidate-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writer creates only a private new config/plan pair, matching the pure output", async () => {
  await inTemp(async (dir) => {
    const target = path.join(dir, "candidate");
    await writeEdgeVpsCandidate(target, valid);
    assert.deepEqual((await readdir(target)).sort(), [
      "haproxy.cfg",
      "plan.json",
    ]);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    for (const name of ["haproxy.cfg", "plan.json"])
      assert.equal((await stat(path.join(target, name))).mode & 0o777, 0o600);
    const expected = candidate();
    assert.equal(
      await readFile(path.join(target, "haproxy.cfg"), "utf8"),
      expected.haproxy,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(target, "plan.json"), "utf8")),
      expected.plan,
    );
  });
});

test("invalid input leaves no candidate; existing output and symlink targets remain untouched", async () => {
  await inTemp(async (dir) => {
    const invalid = path.join(dir, "invalid");
    await assert.rejects(
      writeEdgeVpsCandidate(invalid, {
        ...valid,
        EDGE_MAIN_TUNNEL_IP: "8.8.8.8",
      }),
      { code: "INVALID_EDGE_MAIN_TUNNEL_IP" },
    );
    assert(!(await readdir(dir)).includes("invalid"));
    const existing = path.join(dir, "existing");
    await writeEdgeVpsCandidate(existing, valid);
    const before = await readFile(path.join(existing, "haproxy.cfg"), "utf8");
    await writeFile(path.join(existing, "operator-owned.txt"), "keep");
    await assert.rejects(writeEdgeVpsCandidate(existing, valid), {
      code: "OUTPUT_EXISTS_OR_INVALID",
    });
    assert.equal(
      await readFile(path.join(existing, "haproxy.cfg"), "utf8"),
      before,
    );
    assert.equal(
      await readFile(path.join(existing, "operator-owned.txt"), "utf8"),
      "keep",
    );
    const link = path.join(dir, "link");
    await symlink(existing, link);
    await assert.rejects(writeEdgeVpsCandidate(link, valid), {
      code: "OUTPUT_EXISTS_OR_INVALID",
    });
    assert.equal(
      await readFile(path.join(existing, "operator-owned.txt"), "utf8"),
      "keep",
    );
  });
});

test("CLI requires an explicit absolute output and reports sanitized failure", async () => {
  await inTemp(async (dir) => {
    const sentinel = "private-diagnostic-sentinel";
    const run = (args, changes = {}) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: dir,
        env: { ...process.env, ...valid, ...changes },
        encoding: "utf8",
        timeout: 5000,
      });
    for (const args of [
      [],
      ["--output", "relative"],
      ["--unexpected", sentinel],
    ]) {
      const result = run(args);
      assert.equal(result.status, 1);
      assert(!result.stdout.includes(sentinel));
      assert(!result.stderr.includes(sentinel));
      assert.equal(JSON.parse(result.stderr).ok, false);
    }
    const target = path.join(dir, "candidate");
    const bad = run(["--output", target], { EDGE_MAIN_TUNNEL_IP: sentinel });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stderr).code, "INVALID_EDGE_MAIN_TUNNEL_IP");
    assert(!bad.stderr.includes(sentinel));
    const good = run(["--output", target]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stderr, "");
    const summary = JSON.parse(good.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.deployed, false);
    assert.equal(summary.productionChanges, false);
    assert.equal(summary.public443Accepted, false);
  });
});
