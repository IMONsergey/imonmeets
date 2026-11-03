#!/usr/bin/env node
import { chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
// Explicit opt-in acceptance against disposable loopback services, never production.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  openSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createServer, connect as connectTcp } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createSocket } from "node:dgram";
import https from "node:https";
import { Pool } from "pg";
import { chromium, firefox, webkit } from "@playwright/test";
import { AccessToken } from "livekit-server-sdk";
import { harness, password } from "../apps/api/test/suite-harness.ts";
import { createMedia } from "../apps/api/src/media.ts";

assert.equal(
  process.env.IMON_ISOLATED_LIVEKIT_ACCEPTANCE,
  "1",
  "Explicit isolated acceptance opt-in is required",
);
const runId = process.env.IMON_RUNTIME_RUN_ID;
assert.match(runId ?? "", /^[a-z0-9]{8,32}$/);
const dbUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.equal(dbUrl.hostname, "127.0.0.1");
assert.equal(dbUrl.port, "55441");
assert.equal(dbUrl.pathname, "/imonmeets_test");
const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const stateRoot = "/home/sergey/.local/state/imonmeets-commercial-20261103";
const folder = path.join(stateRoot, "livekit-runtime-" + runId);
const receiptPath = folder + ".json";
const names = [
  "imon-lk-runtime-" + runId,
  "imon-ha-runtime-" + runId,
  "imon-lk-version-" + runId,
];
const appHost = "app.imon-runtime.test",
  rtcHost = "rtc.imon-runtime.test";
const secrets = [];
const cleanText = (value) => {
  let text = String(value)
    .replace(/access_token=[^&\s"']+/g, "access_token=[REDACTED]")
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
      "[JWT]",
    );
  for (const secret of secrets) text = text.split(secret).join("[SECRET]");
  return text.slice(0, 6000);
};
function run(command, args, timeout = 20000) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      cleanText(command + " failed: " + (error.stderr || error.message)),
    );
  }
}
const docker = (args, timeout) =>
  run("sudo", ["-n", "docker", ...args], timeout);
function removeOwnedContainer(name) {
  let owner;
  try {
    owner = docker(
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "imonmeets.runtime.run"}}',
        name,
      ],
      5000,
    );
  } catch {
    return;
  }
  assert.equal(
    owner,
    runId,
    "Refusing to remove a container not owned by this run",
  );
  docker(["rm", "-f", name], 15000);
}
async function genericCleanup() {
  for (const name of names) removeOwnedContainer(name);
  const marker = path.join(folder, "schema-created");
  if (existsSync(marker)) {
    const schema = readFileSync(marker, "utf8").trim();
    assert.match(schema, /^im_suite_[a-f0-9]{32}$/);
    const admin = new Pool({
      connectionString: dbUrl.toString(),
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    } finally {
      await admin.end();
    }
  }
  const pidFile = path.join(folder, "nginx.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        const command = readFileSync("/proc/" + pid + "/cmdline", "utf8");
        if (command.includes(path.join(folder, "nginx.conf")))
          process.kill(pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  }
  assert.equal(
    docker(["ps", "-aq", "--filter", "label=imonmeets.runtime.run=" + runId]),
    "",
  );
  rmSync(folder, { recursive: true, force: true });
}
if (process.argv.includes("--cleanup")) {
  await genericCleanup();
  const receipt = existsSync(receiptPath)
    ? JSON.parse(readFileSync(receiptPath, "utf8"))
    : {
        result: "INTERRUPTED_OR_FAILED",
        runId,
        reason: "Bounded unit ended before a final receipt",
      };
  receipt.outerCleanupVerified = true;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    "CLEANUP verified: only this run's containers, schema and private files",
  );
  process.exit(0);
}
async function tcpPorts(count) {
  const servers = [],
    ports = [];
  try {
    for (let i = 0; i < count; i++) {
      const s = createServer();
      await new Promise((resolve, reject) => {
        s.once("error", reject);
        s.listen(0, "127.0.0.1", resolve);
      });
      servers.push(s);
      ports.push(s.address().port);
    }
  } finally {
    await Promise.all(
      servers.map((s) => new Promise((resolve) => s.close(resolve))),
    );
  }
  return ports;
}
async function udpPort() {
  const socket = createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const port = socket.address().port;
  socket.close();
  return port;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  let error;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch (e) {
      error = e;
    }
    await wait(150);
  } while (Date.now() < end);
  throw error ?? new Error("Acceptance condition timed out");
}
let publicPort;
function request(
  host,
  target,
  { method = "GET", body, cookie, headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: publicPort,
        servername: host,
        rejectUnauthorized: false,
        path: target,
        method,
        headers: {
          Host: host,
          Origin: "https://" + appHost,
          ...headers,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (response) => {
        const parts = [];
        let bytes = 0;
        response.on("data", (part) => {
          bytes += part.length;
          if (bytes > 1024 * 1024)
            req.destroy(new Error("Bounded response exceeded"));
          else parts.push(part);
        });
        response.on("end", () => {
          const text = Buffer.concat(parts).toString();
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            json,
          });
        });
      },
    );
    req.setTimeout(15000, () =>
      req.destroy(new Error("Local HTTP deadline exceeded")),
    );
    req.once("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const api = (target, options) => request(appHost, target, options);
function cookieOf(response) {
  const values = response.headers["set-cookie"] ?? [];
  return (Array.isArray(values) ? values : [values])
    .map((value) => value.split(";")[0])
    .join("; ");
}
const receipt = {
  schema: 1,
  runId,
  result: "RUNNING",
  startedAt: new Date().toISOString(),
  checks: [],
  limits: {
    verifierCpu: 1,
    verifierMemoryMiB: 2048,
    verifierTasks: 256,
    livekitCpu: 0.5,
    livekitMemoryMiB: 256,
    haproxyCpu: 0.1,
    haproxyMemoryMiB: 64,
  },
  scope:
    "isolated loopback; synthetic canvas video and oscillator audio only; no real devices, mail, payments, TURN or production traffic",
};
function passed(name) {
  receipt.checks.push(name);
  console.log("PASS " + name);
}
let h, browser, nginx, page, browserProxy;
const browserProxySockets = new Set();
try {
  mkdirSync(folder, { mode: 0o700 });
  receipt.nodeVersion = process.version;
  receipt.coreCommit = run("git", ["-C", root, "rev-parse", "HEAD"]);
  receipt.runnerSha256 = createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
  receipt.requestedBrowserEngine =
    process.env.IMON_BROWSER_ENGINE || "chromium";
  const generator = path.resolve(
    process.env.IMON_INGRESS_GENERATOR ??
      path.join(root, "scripts/prepare-ingress443.mjs"),
  );
  receipt.generatorSha256 = createHash("sha256")
    .update(readFileSync(generator))
    .digest("hex");
  const { ingressConfig, renderIngress, HAPROXY_IMAGE } = await import(
    pathToFileURL(generator).href
  );
  receipt.haproxyImage = HAPROXY_IMAGE;
  const image = docker([
    "image",
    "inspect",
    "livekit/livekit-server:v1.13.11",
    "--format",
    "{{.Id}}",
  ]);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  receipt.livekitImage = image;
  const baseDocker = [
    "--pull=never",
    "--label",
    "imonmeets.runtime.run=" + runId,
    "--label",
    "imonmeets.scope=disposable-livekit-acceptance",
  ];
  const version = docker([
    "run",
    "--rm",
    "--name",
    names[2],
    ...baseDocker,
    "--network",
    "none",
    "--cpus",
    "0.5",
    "--memory",
    "256m",
    image,
    "--version",
  ]);
  assert.match(version, /\b1\.13\.11\b/);
  receipt.livekitVersion = version;
  passed("exact local LiveKit 1.13.11 image; no pull");
  // Allocate every TCP endpoint while all reservation sockets remain open.
  // Separate port-0 batches may otherwise return an earlier endpoint's number.
  const ports = await tcpPorts(8);
  assert.equal(new Set(ports).size, ports.length);
  [publicPort] = ports;
  const [
    ,
    plainPort,
    nginxPort,
    apiPort,
    rtcPort,
    turnPort,
    mediaTcpPort,
    browserProxyPort,
  ] = ports;
  const mediaPort = await udpPort();
  receipt.fixturePorts = {
    publicPort,
    plainPort,
    nginxPort,
    apiPort,
    rtcPort,
    turnPort,
    mediaTcpPort,
    browserProxyPort,
    mediaUdpPort: mediaPort,
  };
  const key = "runtime" + randomBytes(12).toString("hex"),
    secret = randomBytes(48).toString("base64url");
  const proxySecret = randomBytes(32).toString("base64url"),
    signalingSecret = randomBytes(32).toString("base64url");
  secrets.push(secret, proxySecret, signalingSecret);
  const livekitConfig = {
    port: 7880,
    bind_addresses: ["0.0.0.0"],
    rtc: {
      tcp_port: mediaTcpPort,
      udp_port: mediaPort,
      use_external_ip: false,
      node_ip: "127.0.0.1",
      // The SFU runs in a bridge container. Its own 127.0.0.1 is not the host
      // loopback published by Docker; collecting it breaks reverse ICE checks.
      // Advertise the host mapping, but keep the backing interface on the bridge.
      enable_loopback_candidate: false,
      stun_servers: ["127.0.0.1:" + mediaPort],
    },
    keys: { [key]: secret },
    logging: { level: "debug", pion_level: "debug" },
  };
  writeFileSync(
    path.join(folder, "livekit.yaml"),
    JSON.stringify(livekitConfig),
    { mode: 0o600 },
  );
  // The parent directory is 0700; only this read-only container mount needs a readable file.
  chmodSync(path.join(folder, "livekit.yaml"), 0o644);
  docker([
    "run",
    "-d",
    "--name",
    names[0],
    ...baseDocker,
    "--network",
    "bridge",
    "--cpus",
    "0.5",
    "--memory",
    "256m",
    "--memory-swap",
    "256m",
    "--pids-limit",
    "128",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--env",
    "GOMEMLIMIT=192MiB",
    "-p",
    "127.0.0.1:" + rtcPort + ":7880/tcp",
    "-p",
    "127.0.0.1:" + mediaTcpPort + ":" + mediaTcpPort + "/tcp",
    "-p",
    "127.0.0.1:" + mediaPort + ":" + mediaPort + "/udp",
    "-v",
    path.join(folder, "livekit.yaml") + ":/livekit.yaml:ro",
    image,
    "--config",
    "/livekit.yaml",
  ]);
  const bindings = JSON.parse(
    docker([
      "inspect",
      "--format",
      "{{json .HostConfig.PortBindings}}",
      names[0],
    ]),
  );
  assert.ok(
    Object.values(bindings)
      .flat()
      .every((entry) => entry.HostIp === "127.0.0.1"),
  );
  receipt.serverBindings = Object.entries(bindings).map(
    ([containerPort, values]) => ({
      containerPort,
      hostIp: values[0].HostIp,
      hostPort: values[0].HostPort,
    }),
  );
  h = await harness({
    APP_URL: "https://" + appHost,
    ORIGIN_PROXY_SECRET: proxySecret,
    LIVEKIT_URL: "wss://" + rtcHost + ":" + publicPort,
    LIVEKIT_INTERNAL_URL: "http://127.0.0.1:" + rtcPort,
    LIVEKIT_API_KEY: key,
    LIVEKIT_API_SECRET: secret,
    LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
    LIVEKIT_SIGNALING_AUTH_SECRET: signalingSecret,
  });
  const schema = (await h.pool.query("SELECT current_schema() AS name")).rows[0]
    .name;
  assert.match(schema, /^im_suite_[a-f0-9]{32}$/);
  writeFileSync(path.join(folder, "schema-created"), schema, { mode: 0o600 });
  // The standard DB harness mocks media. Replace every member, including closure-bound token(), with real clients.
  Object.assign(h.media, createMedia(h.c));
  await until(async () => {
    await h.media.rooms.listRooms();
    return true;
  }, 20000);
  const sdk = readFileSync(
    path.join(root, "node_modules/livekit-client/dist/livekit-client.umd.js"),
  );
  await h.app.listen({ host: "127.0.0.1", port: apiPort });
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=" + appHost,
    "-addext",
    "subjectAltName=DNS:" +
      appHost +
      ",DNS:" +
      rtcHost +
      ",DNS:turn.imon-runtime.test",
    "-keyout",
    path.join(folder, "key.pem"),
    "-out",
    path.join(folder, "cert.pem"),
  ]);
  const config = ingressConfig({
    INGRESS_PUBLIC_IP: "192.0.2.20",
    VPN_PUBLIC_IP: "192.0.2.21",
    APP_URL: "https://" + appHost,
    LIVEKIT_URL: "wss://" + rtcHost,
    TURN_PUBLIC_HOST: "turn.imon-runtime.test",
    LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
    ORIGIN_PROXY_SECRET: proxySecret,
    LIVEKIT_SIGNALING_AUTH_SECRET: signalingSecret,
  });
  const rendered = renderIngress(config, {
    bind: "127.0.0.1",
    publicPort,
    httpPort: plainPort,
    nginxPort,
    apiPort,
    rtcPort,
    turnPort,
    cert: path.join(folder, "cert.pem"),
    key: path.join(folder, "key.pem"),
    trust: path.join(folder, "trust.conf"),
    signal: path.join(folder, "signal.conf"),
    acme: path.join(folder, "acme"),
  });
  for (const [kind, name] of [
    ["nginx", "routes.conf"],
    ["haproxy", "haproxy.cfg"],
    ["trust", "trust.conf"],
    ["signal", "signal.conf"],
  ])
    writeFileSync(path.join(folder, name), rendered[kind], { mode: 0o600 });
  writeFileSync(
    path.join(folder, "nginx.conf"),
    "worker_processes 1;\npid " +
      folder +
      "/nginx.pid;\nerror_log " +
      folder +
      "/nginx.error.log warn;\nevents { worker_connections 128; }\nhttp { access_log off; client_body_temp_path " +
      folder +
      "/body; proxy_temp_path " +
      folder +
      "/proxy; include " +
      folder +
      "/routes.conf; }\n",
    { mode: 0o600 },
  );
  chmodSync(path.join(folder, "haproxy.cfg"), 0o644);
  run("/usr/sbin/nginx", [
    "-t",
    "-p",
    folder,
    "-c",
    path.join(folder, "nginx.conf"),
  ]);
  const fd = openSync(path.join(folder, "nginx.stdout.log"), "w", 0o600);
  nginx = spawn(
    "/usr/sbin/nginx",
    ["-p", folder, "-c", path.join(folder, "nginx.conf"), "-g", "daemon off;"],
    { stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  docker([
    "run",
    "-d",
    "--name",
    names[1],
    ...baseDocker,
    "--network",
    "host",
    "--cpus",
    "0.1",
    "--memory",
    "64m",
    "--memory-swap",
    "64m",
    "--pids-limit",
    "32",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--security-opt",
    "no-new-privileges",
    "-v",
    path.join(folder, "haproxy.cfg") + ":/usr/local/etc/haproxy/haproxy.cfg:ro",
    HAPROXY_IMAGE,
    "haproxy",
    "-W",
    "-db",
    "-f",
    "/usr/local/etc/haproxy/haproxy.cfg",
  ]);
  await until(async () => (await api("/")).status === 200, 15000);
  passed(
    "real API, nginx auth_request and pinned HAProxy SNI path; owned loopback ports only",
  );
  const signup = await api("/api/auth/sign-up/email", {
    method: "POST",
    body: {
      name: "Synthetic owner",
      email: "runtime-" + runId + "@example.test",
      password,
    },
  });
  assert.equal(signup.status, 200, cleanText(signup.text));
  const ownerCookie = cookieOf(signup);
  await h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [
    "runtime-" + runId + "@example.test",
  ]);
  const workspace = await api("/api/workspaces", {
    method: "POST",
    cookie: ownerCookie,
    body: { name: "Isolated runtime acceptance" },
  });
  assert.equal(workspace.status, 200, cleanText(workspace.text));
  const wid = workspace.json.workspace.id;
  const created = await api("/api/workspaces/" + wid + "/rooms", {
    method: "POST",
    cookie: ownerCookie,
    body: {
      title: "Synthetic runtime",
      maxParticipants: 10,
      waitingRoom: false,
    },
  });
  assert.equal(created.status, 200, cleanText(created.text));
  let room = created.json.room;
  const join = async (cookie) => {
    const response = await api("/api/rooms/" + room.slug + "/join", {
      method: "POST",
      cookie,
      body: { name: "Synthetic participant" },
    });
    assert.equal(response.status, 200, cleanText(response.text));
    return { ...response.json, cookie: cookieOf(response) || cookie };
  };
  const a = await join(ownerCookie),
    b = await join(),
    legacy = await join();
  const preflight = await request(
    rtcHost,
    "/rtc/validate?" +
      new URLSearchParams({
        access_token: a.token,
        sdk: "js",
        version: "2.23.0",
        protocol: "9",
      }),
  );
  receipt.legacyValidationPreflight = {
    status: preflight.status,
    body: cleanText(preflight.text).slice(0, 160),
  };
  assert.equal(
    preflight.status,
    200,
    "Real admission/LiveKit validation preflight",
  );
  passed("real protected LiveKit validation accepts the persisted API grant");
  const wsSeen = [];
  const engineName = process.env.IMON_BROWSER_ENGINE || "chromium";
  assert.ok(["chromium", "firefox", "webkit"].includes(engineName));
  const engine = { chromium, firefox, webkit }[engineName];
  const executablePath =
    process.env.IMON_BROWSER_EXECUTABLE ||
    (engineName === "chromium"
      ? "/usr/bin/google-chrome"
      : engine.executablePath());
  const launchOptions = { executablePath, headless: true, timeout: 15000 };
  receipt.browserEngine = engineName;
  receipt.browserExecutable = executablePath;
  receipt.chromiumFlagsUsed = engineName === "chromium";
  if (engineName === "firefox") {
    // Firefox deliberately excludes loopback ICE/STUN by default. This preference
    // is set only in the disposable loopback test profile, never a user's browser.
    launchOptions.firefoxUserPrefs = {
      "media.peerconnection.ice.loopback": true,
    };
    receipt.firefoxUserPrefs = { ...launchOptions.firefoxUserPrefs };
  }
  if (engineName === "chromium") {
    launchOptions.args = [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--renderer-process-limit=2",
      "--no-proxy-server",
      "--disable-background-networking",
      "--ignore-certificate-errors",
      "--autoplay-policy=no-user-gesture-required",
      "--host-resolver-rules=MAP " +
        appHost +
        " 127.0.0.1, MAP " +
        rtcHost +
        " 127.0.0.1",
    ];
  } else {
    // Other engines have no Chromium DNS flags. This loopback-only CONNECT proxy
    // maps only this fixture's HTTPS/WSS hosts and exact owned ICE/TCP port.
    // Every other target is refused without making an outbound connection.
    const proxyPort = browserProxyPort;
    browserProxy = createHttpServer((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    browserProxy.on("connect", (request, socket, head) => {
      let target;
      try {
        target = new URL("http://" + request.url);
      } catch {
        socket.destroy();
        return;
      }
      const port = Number(target.port);
      const application =
        [appHost, rtcHost].includes(target.hostname) && port === publicPort;
      const media = target.hostname === "127.0.0.1" && port === mediaTcpPort;
      if (
        (!application && !media) ||
        target.username ||
        target.password ||
        target.pathname !== "/"
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = connectTcp({ host: "127.0.0.1", port });
      for (const stream of [socket, upstream]) {
        browserProxySockets.add(stream);
        stream.once("close", () => browserProxySockets.delete(stream));
      }
      socket.once("error", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      browserProxy.once("error", reject);
      browserProxy.listen(proxyPort, "127.0.0.1", resolve);
    });
    launchOptions.proxy = { server: "http://127.0.0.1:" + proxyPort };
    receipt.browserProxy = {
      bind: "127.0.0.1",
      port: proxyPort,
      externalTargetsAllowed: false,
    };
  }
  browser = await engine.launch(launchOptions);
  receipt.browserVersion = browser.version();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  await context.route("**/*", (route) =>
    [appHost, rtcHost].includes(new URL(route.request().url()).hostname)
      ? route.continue()
      : route.abort(),
  );
  page = await context.newPage();
  receipt.browserTransport = [];
  page.on("requestfailed", (request) => {
    const u = new URL(request.url());
    receipt.browserTransport.push({
      type: "failed",
      host: u.hostname,
      path: u.pathname,
      reason: cleanText(request.failure()?.errorText ?? "unknown"),
    });
  });
  page.on("response", (response) => {
    const u = new URL(response.url());
    if (u.hostname === rtcHost)
      receipt.browserTransport.push({
        type: "response",
        path: u.pathname,
        status: response.status(),
      });
  });
  page.on("websocket", (socket) =>
    socket.on("socketerror", (error) =>
      receipt.browserTransport.push({
        type: "websocket-error",
        message: cleanText(error),
      }),
    ),
  );

  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (url.hostname === rtcHost) {
      wsSeen.push(url);
      receipt.signalFrames ??= {};
      socket.on("framereceived", () => {
        receipt.signalFrames[url.pathname] =
          (receipt.signalFrames[url.pathname] ?? 0) + 1;
      });
    }
  });
  await page.goto("https://" + appHost + ":" + publicPort + "/");
  await page.setContent(
    '<!doctype html><title>Synthetic media acceptance</title><body><button id="runtime-start">Start synthetic media</button></body>',
  );
  await page.evaluate(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    const keys = [
      "id",
      "type",
      "kind",
      "mediaType",
      "state",
      "nominated",
      "selected",
      "writable",
      "localCandidateId",
      "remoteCandidateId",
      "selectedCandidatePairId",
      "candidateType",
      "protocol",
      "tcpType",
      "address",
      "port",
      "relatedAddress",
      "relatedPort",
      "networkType",
      "bytesSent",
      "bytesReceived",
      "packetsSent",
      "packetsReceived",
      "requestsSent",
      "requestsReceived",
      "responsesSent",
      "responsesReceived",
      "currentRoundTripTime",
      "connectionState",
      "dtlsState",
      "iceState",
      "framesDecoded",
      "framesEncoded",
      "framesReceived",
      "codecId",
      "mimeType",
      "totalAudioEnergy",
      "totalSamplesReceived",
      "concealedSamples",
    ];
    window.runtimeIce = [];
    window.RTCPeerConnection = class ObservedPeerConnection extends (
      NativePeerConnection
    ) {
      constructor(config, constraints) {
        super(config, constraints);
        const trace = {
          index: window.runtimeIce.length,
          states: [],
          candidates: [],
          errors: [],
          stats: [],
        };
        window.runtimeIce.push(trace);
        const capture = async () => {
          try {
            const stats = await this.getStats();
            const filteredStats = Array.from(stats.values())
              .filter((stat) =>
                [
                  "local-candidate",
                  "remote-candidate",
                  "candidate-pair",
                  "transport",
                  "inbound-rtp",
                  "outbound-rtp",
                  "codec",
                ].includes(stat.type),
              )
              .map((stat) =>
                Object.fromEntries(
                  keys
                    .filter((key) => stat[key] !== undefined)
                    .map((key) => [key, stat[key]]),
                ),
              );
            if (filteredStats.length) trace.stats = filteredStats;
            if (this.localDescription)
              trace.localCandidates =
                this.localDescription.sdp
                  .split("\r\n")
                  .filter((line) => line.startsWith("a=candidate:"))
                  .map((line) => line.replace(/ ufrag [^ ]+/g, "")) ?? [];
            if (this.remoteDescription)
              trace.remoteCandidates =
                this.remoteDescription.sdp
                  .split("\r\n")
                  .filter((line) => line.startsWith("a=candidate:"))
                  .map((line) => line.replace(/ ufrag [^ ]+/g, "")) ?? [];
          } catch {
            /* The SDK may already have closed this connection. */
          }
        };
        trace.capture = capture;
        this.addEventListener("icecandidate", (event) => {
          if (event.candidate)
            trace.candidates.push(
              event.candidate.candidate.replace(/ ufrag [^ ]+/g, ""),
            );
        });
        for (const event of [
          "iceconnectionstatechange",
          "connectionstatechange",
          "icegatheringstatechange",
        ])
          this.addEventListener(event, () => {
            trace.states.push({
              event,
              ice: this.iceConnectionState,
              connection: this.connectionState,
              gathering: this.iceGatheringState,
            });
            void capture();
          });
        this.addEventListener("icecandidateerror", (event) =>
          trace.errors.push({
            url: event.url,
            errorCode: event.errorCode,
            errorText: event.errorText,
          }),
        );
        const timer = setInterval(() => {
          void capture();
        }, 500);
        this.addEventListener("connectionstatechange", () => {
          if (this.connectionState === "closed") clearInterval(timer);
        });
      }
    };
    window.runtimeIceSnapshot = async () => {
      await Promise.all(window.runtimeIce.map((trace) => trace.capture()));
      return window.runtimeIce.map(({ capture, ...trace }) => trace);
    };
  });
  await page.addScriptTag({ content: sdk.toString("utf8") });
  await page.evaluate(
    ({ serverUrl, localStun }) => {
      window.runtimePeers = {};
      window.runtimeTimers = [];
      window.runtimeAudioContext = new AudioContext({ sampleRate: 48000 });
      window.runtimeAudio = [];
      window.runtimeAudioErrors = [];
      window.runtimeOscillators = [];
      window.runtimeAudioSnapshot = () =>
        window.runtimeAudio.map(({ receiver, analyser, track }) => {
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          const spectrum = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(spectrum);
          let peak = 1;
          for (let bin = 2; bin < spectrum.length; bin++)
            if (spectrum[bin] > spectrum[peak]) peak = bin;
          return {
            receiver,
            expectedHz: receiver === "a" ? 660 : 440,
            dominantHz:
              (peak * window.runtimeAudioContext.sampleRate) / analyser.fftSize,
            rms: Math.sqrt(
              samples.reduce((sum, sample) => sum + sample * sample, 0) /
                samples.length,
            ),
            sampleRate: window.runtimeAudioContext.sampleRate,
            contextState: window.runtimeAudioContext.state,
            trackState: track.mediaStreamTrack.readyState,
          };
        });
      window.runtimeConnect = async (slot, token, publish) => {
        const sdk = window.LivekitClient,
          peer = new sdk.Room({ adaptiveStream: false, dynacast: false });
        window.runtimePeers[slot] = peer;
        peer.on(sdk.RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === "audio") {
            // Attach using the SDK's normal playback path; the output stays muted.
            const element = track.attach();
            element.muted = true;
            element.autoplay = true;
            document.body.appendChild(element);
            void element
              .play()
              .catch((error) => window.runtimeAudioErrors.push(String(error)));

            const source = window.runtimeAudioContext.createMediaStreamSource(
              new MediaStream([track.mediaStreamTrack]),
            );
            const analyser = window.runtimeAudioContext.createAnalyser();
            analyser.fftSize = 2048;
            const silentOutput = window.runtimeAudioContext.createGain();
            silentOutput.gain.value = 0;
            source
              .connect(analyser)
              .connect(silentOutput)
              .connect(window.runtimeAudioContext.destination);
            window.runtimeAudio.push({
              receiver: slot,
              analyser,
              track,
              source,
              silentOutput,
            });
            return;
          }
          if (track.kind !== "video") return;
          const element = track.attach();
          element.dataset.receiver = slot;
          element.muted = true;
          element.autoplay = true;
          document.body.appendChild(element);
          void element.play();
        });
        await window.runtimeAudioContext.resume();
        await peer.connect(serverUrl, token, {
          autoSubscribe: true,
          maxRetries: 0,
          websocketTimeout: 10000,
          peerConnectionTimeout: 15000,
          rtcConfig: { iceServers: [{ urls: localStun }] },
        });
        if (publish) {
          const destination =
            window.runtimeAudioContext.createMediaStreamDestination();
          const oscillator = window.runtimeAudioContext.createOscillator();
          oscillator.frequency.value = slot === "a" ? 440 : 660;
          const gain = window.runtimeAudioContext.createGain();
          gain.gain.value = 0.1;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          window.runtimeOscillators.push(oscillator);
          await peer.localParticipant.publishTrack(
            destination.stream.getAudioTracks()[0],
            {
              source: sdk.Track.Source.Microphone,
              name: "synthetic-tone-" + slot,
              audioPreset: { maxBitrate: 32000 },
              dtx: false,
              red: false,
              forceStereo: false,
            },
          );
          const canvas = document.createElement("canvas");
          canvas.width = 160;
          canvas.height = 90;
          let frame = 0;
          const draw = () => {
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = slot === "a" ? "#158a49" : "#3255b2";
            ctx.fillRect(0, 0, 160, 90);
            // Distinct achromatic bits survive VP8 chroma conversion. Exact RGB
            // equality is not a transport property of a lossy video codec.
            ctx.fillStyle = slot === "a" ? "black" : "white";
            ctx.fillRect(96, 8, 24, 24);
            ctx.fillStyle = slot === "a" ? "white" : "black";
            ctx.fillRect(128, 8, 24, 24);
            ctx.fillStyle = "white";
            ctx.fillText(slot + " synthetic " + frame++, 10, 40);
          };
          draw();
          window.runtimeTimers.push(setInterval(draw, 500));
          const track = canvas.captureStream(2).getVideoTracks()[0];
          await peer.localParticipant.publishTrack(track, {
            name: "synthetic-canvas-" + slot,
            videoCodec: "vp8",
            simulcast: false,
            videoEncoding: { maxBitrate: 80000, maxFramerate: 2 },
          });
        }
        return peer.state;
      };
      window.runtimeAttempt = async (token) => {
        const peer = new sdkRoom();
        let timedOut = false,
          connected = false;
        let timer;
        try {
          await Promise.race([
            peer.connect(serverUrl, token, {
              maxRetries: 0,
              websocketTimeout: 4000,
              peerConnectionTimeout: 4000,
              rtcConfig: { iceServers: [{ urls: localStun }] },
            }),
            new Promise((_resolve, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error("attempt timeout"));
              }, 10000);
            }),
          ]);
          connected = true;
        } catch {
          /* Explicit gate status is independently asserted for every path. */
        } finally {
          clearTimeout(timer);
          await peer.disconnect();
        }
        return { connected, timedOut };
      };
      function sdkRoom() {
        return new window.LivekitClient.Room({
          adaptiveStream: false,
          dynacast: false,
        });
      }
    },
    { serverUrl: h.c.livekit.url, localStun: "stun:127.0.0.1:" + mediaPort },
  );
  // Unlock audio through a real trusted input event on each engine, without
  // capturing any hardware or relying on Chromium autoplay switches elsewhere.
  await page.evaluate(() => {
    document.getElementById("runtime-start").onclick = () =>
      window.runtimeAudioContext.resume();
  });
  await page.getByRole("button", { name: "Start synthetic media" }).click();
  try {
    await page.evaluate(
      async ({ a, b }) => {
        await window.runtimeConnect("a", a, true);
        await window.runtimeConnect("b", b, true);
      },
      { a: a.token, b: b.token },
    );
    await page.waitForFunction(
      () =>
        ["a", "b"].every((slot) =>
          Array.from(document.querySelectorAll("video")).some(
            (video) =>
              video.dataset.receiver === slot &&
              video.videoWidth === 160 &&
              video.getVideoPlaybackQuality().totalVideoFrames >= 2,
          ),
        ),
      undefined,
      { timeout: 30000 },
    );
    receipt.media = await page.evaluate(() =>
      Array.from(document.querySelectorAll("video")).map((video) => {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0);
        return {
          receiver: video.dataset.receiver,
          width: video.videoWidth,
          height: video.videoHeight,
          decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
          rgb: Array.from(context.getImageData(10, 10, 1, 1).data).slice(0, 3),
          pixelSignature: [104, 136].map((x) =>
            Array.from(context.getImageData(x, 16, 1, 1).data).slice(0, 3),
          ),
          expectedSignature: video.dataset.receiver === "a" ? [1, 0] : [0, 1],
          expectedRgb:
            video.dataset.receiver === "a" ? [50, 85, 178] : [21, 138, 73],
        };
      }),
    );
    assert.equal(receipt.media.length, 2);
    for (const video of receipt.media)
      assert.ok(
        video.pixelSignature.every((pixel, index) =>
          pixel.every((channel) =>
            video.expectedSignature[index] === 1 ? channel > 205 : channel < 50,
          ),
        ),
        "Remote decoded frame must carry the other participant's two-bit signature",
      );
    receipt.videoAccepted = true;
    await page.waitForFunction(
      () => {
        const audio = window.runtimeAudioSnapshot();
        return ["a", "b"].every((slot) =>
          audio.some(
            (sample) =>
              sample.receiver === slot &&
              sample.rms > 0.005 &&
              Math.abs(sample.dominantHz - sample.expectedHz) < 50 &&
              sample.trackState === "live",
          ),
        );
      },
      undefined,
      { timeout: 15000 },
    );
    receipt.audio = await page.evaluate(() => window.runtimeAudioSnapshot());
    assert.equal(receipt.audio.length, 2);
    receipt.audioAccepted = true;
    assert.ok(wsSeen.some((url) => url.pathname === "/rtc/v1"));
    assert.equal((await h.media.rooms.listParticipants(room.id)).length, 2);
    passed(
      "two real /rtc/v1 WebRTC peers exchange decoded synthetic VP8 frames and the expected remote Opus audio tones",
    );
    receipt.mediaAccepted = true;
    receipt.iceDiagnostics = await page.evaluate(() =>
      window.runtimeIceSnapshot(),
    );
    receipt.mediaTransports = receipt.iceDiagnostics.map((trace) => {
      const transport = trace.stats.find(
        (stat) => stat.type === "transport" && stat.selectedCandidatePairId,
      );
      const pair = transport
        ? trace.stats.find(
            (stat) => stat.id === transport.selectedCandidatePairId,
          )
        : trace.stats.find(
            (stat) =>
              stat.type === "candidate-pair" &&
              stat.state === "succeeded" &&
              (stat.selected === true || stat.nominated === true),
          );
      assert.equal(pair?.state, "succeeded");
      assert.ok(
        pair?.nominated === true || pair?.selected === true,
        "Native ICE stats must identify the selected/nominated pair",
      );
      if (transport?.dtlsState !== undefined)
        assert.equal(transport.dtlsState, "connected");
      const candidate = trace.stats.find(
        (stat) => stat.id === pair.remoteCandidateId,
      );
      assert.ok(candidate, "Selected ICE pair must have a remote candidate");
      const audio = trace.stats.find(
        (stat) =>
          stat.type === "inbound-rtp" &&
          (stat.kind ?? stat.mediaType) === "audio",
      );
      const video = trace.stats.find(
        (stat) =>
          stat.type === "inbound-rtp" &&
          (stat.kind ?? stat.mediaType) === "video",
      );
      assert.ok(
        audio?.bytesReceived > 0,
        "Audio RTP must arrive; decoded samples are independently proven by the remote waveform",
      );
      assert.ok(
        video?.bytesReceived > 0,
        "Video RTP must arrive; decoded frames are independently proven by playback quality and pixel signatures",
      );
      // Stats dictionaries differ between engines. A reported decode counter must
      // be positive; a missing optional counter stays unreported, never fabricated.
      if (audio.totalSamplesReceived !== undefined)
        assert.ok(audio.totalSamplesReceived > 0);
      if (video.framesDecoded !== undefined)
        assert.ok(video.framesDecoded >= 2);
      return {
        peer: trace.index,
        protocol: candidate.protocol,
        remoteAddress: candidate.address ?? candidate.ip ?? null,
        dtlsState: transport?.dtlsState ?? null,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        audioSamples: audio.totalSamplesReceived ?? null,
        audioBytes: audio.bytesReceived,
        videoFrames: video.framesDecoded ?? null,
        videoBytes: video.bytesReceived,
      };
    });
    assert.equal(receipt.mediaTransports.length, 2);
    receipt.transportProtocols = [
      ...new Set(receipt.mediaTransports.map((item) => item.protocol)),
    ];
    receipt.udpAccepted = receipt.transportProtocols.includes("udp");
    receipt.tcpAccepted = receipt.transportProtocols.includes("tcp");
  } catch (mediaError) {
    receipt.mediaAccepted = false;
    receipt.scope =
      "isolated loopback; synthetic audio/video media acceptance FAILED; no real devices, mail, payments, TURN or production traffic";
    receipt.mediaFailure = cleanText(mediaError.message || mediaError);
    receipt.audio = await page.evaluate(() => window.runtimeAudioSnapshot());
    receipt.audioPlaybackErrors = await page.evaluate(
      () => window.runtimeAudioErrors,
    );

    receipt.iceDiagnostics = await page.evaluate(() =>
      window.runtimeIceSnapshot(),
    );
    const diagnosticLog = spawnSync(
      "sudo",
      ["-n", "docker", "logs", "--tail", "160", names[0]],
      { encoding: "utf8", timeout: 5000, maxBuffer: 262144 },
    );
    receipt.livekitMediaDiagnostics = cleanText(
      (diagnosticLog.stdout || "") + (diagnosticLog.stderr || ""),
    );
    throw mediaError; // A signaling-only connection can never satisfy this media acceptance.
  }
  assert.ok(
    (receipt.signalFrames?.["/rtc/v1"] ?? 0) > 0,
    "Real v1 server response must have arrived",
  );
  passed("real /rtc/v1 WebSocket receives LiveKit server signaling frames");
  const v1 = wsSeen.find((url) => url.pathname === "/rtc/v1");
  assert.ok(v1.searchParams.has("join_request"));
  for (const [route, query] of [
    [
      "/rtc/validate",
      new URLSearchParams({
        access_token: legacy.token,
        sdk: "js",
        version: "2.23.0",
        protocol: "9",
        auto_subscribe: "0",
      }),
    ],
    ["/rtc/v1/validate", v1.searchParams],
  ]) {
    const response = await request(rtcHost, route + "?" + query.toString());
    assert.equal(response.status, 200, route + ": " + cleanText(response.text));
    passed("real LiveKit accepts " + route);
  }
  const legacyUrl =
    h.c.livekit.url +
    "/rtc?" +
    new URLSearchParams({
      access_token: legacy.token,
      sdk: "js",
      version: "2.23.0",
      protocol: "9",
      auto_subscribe: "0",
    });
  const legacyHandshake = await page.evaluate(
    (url) =>
      new Promise((resolve) => {
        const ws = new WebSocket(url);
        let opened = false;
        const timer = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 7000);
        ws.onopen = () => {
          opened = true;
        };
        ws.onmessage = () => {
          clearTimeout(timer);
          ws.close();
          resolve(opened);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      }),
    legacyUrl,
  );
  assert.equal(legacyHandshake, true);
  passed("real legacy /rtc WebSocket upgrade and server join response");
  assert.equal((await api("/api/internal/livekit/authorize")).status, 404);
  assert.equal(
    (await request(rtcHost, "/twirp/livekit.RoomService/ListRooms")).status,
    404,
  );
  passed("public internal authorization and management paths remain blocked");
  const denied = async (token, label) => {
    for (const route of [
      "/rtc",
      "/rtc/validate",
      "/rtc/v1",
      "/rtc/v1/validate",
    ]) {
      const response = await request(
        rtcHost,
        route + "?access_token=" + encodeURIComponent(token),
      );
      assert.equal(response.status, 403, label + " " + route);
    }
    const attempt = await page.evaluate(
      (token) => window.runtimeAttempt(token),
      token,
    );
    assert.deepEqual(attempt, { connected: false, timedOut: false });
    passed(
      label + ": all four signal paths reject, actual SDK reconnect rejects",
    );
  };
  const signed = async (identity, mediaName) => {
    const token = new AccessToken(key, secret, { identity, ttl: 300 });
    token.addGrant({
      roomJoin: true,
      room: mediaName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return token.toJwt();
  };
  const remove = async (identity, ban) => {
    const response = await api(
      "/api/workspaces/" +
        wid +
        "/rooms/" +
        room.id +
        "/participants/" +
        encodeURIComponent(identity) +
        "/remove",
      { method: "POST", cookie: ownerCookie, body: { ban } },
    );
    assert.equal(response.status, 200, cleanText(response.text));
  };
  await remove(b.identity, false);
  await page.waitForFunction(
    () => window.runtimePeers.b.state === "disconnected",
    undefined,
    { timeout: 15000 },
  );
  assert.equal(
    await page.evaluate(() => window.runtimePeers.a.state),
    "connected",
  );
  passed("targeted kick disconnects only the selected real participant");
  await denied(b.token, "kicked original JWT");
  await denied(
    await signed(b.identity, room.id),
    "freshly signed JWT for kicked identity",
  );
  const b2 = await join(b.cookie);
  await page.evaluate(
    ({ token }) => window.runtimeConnect("b2", token, false),
    { token: b2.token },
  );
  passed("kick permits a new authorized API grant with a new identity");
  await remove(b2.identity, true);
  await page.waitForFunction(
    () => window.runtimePeers.b2.state === "disconnected",
    undefined,
    { timeout: 15000 },
  );
  assert.equal(
    await page.evaluate(() => window.runtimePeers.a.state),
    "connected",
  );
  await denied(b2.token, "banned original JWT");
  const blocked = await api("/api/rooms/" + room.slug + "/join", {
    method: "POST",
    cookie: b.cookie,
    body: { name: "Synthetic participant" },
  });
  assert.equal(blocked.status, 403);
  const freshGuest = await api("/api/rooms/" + room.slug + "/join", {
    method: "POST",
    body: { name: "Fresh synthetic browser" },
  });
  assert.equal(freshGuest.status, 200, cleanText(freshGuest.text));
  assert.equal(freshGuest.json.status, "waiting");
  assert.equal(freshGuest.json.token, undefined);
  assert.equal(typeof freshGuest.json.waitingToken, "string");
  assert.equal(typeof freshGuest.json.requestId, "string");
  passed(
    "ban blocks known browser grant; fresh anonymous browser requires admission; innocent peer stays connected",
  );
  const rotated = await api(
    "/api/workspaces/" + wid + "/rooms/" + room.id + "/rotate-link",
    { method: "POST", cookie: ownerCookie, body: {} },
  );
  assert.equal(rotated.status, 200, cleanText(rotated.text));
  room = rotated.json.room;
  await page.waitForFunction(
    () => window.runtimePeers.a.state === "disconnected",
    undefined,
    { timeout: 15000 },
  );
  const generation = (
    await h.pool.query("SELECT media_generation FROM im_rooms WHERE id=$1", [
      room.id,
    ])
  ).rows[0].media_generation;
  const currentMedia = generation === 0 ? room.id : room.id + "-g" + generation;
  await denied(a.token, "original JWT after room generation rotation");
  await denied(
    await signed(a.identity, currentMedia),
    "freshly signed JWT with old identity for new generation",
  );
  const a2 = await join(ownerCookie);
  await page.evaluate(
    ({ token }) => window.runtimeConnect("a2", token, false),
    { token: a2.token },
  );
  assert.equal(
    await page.evaluate(() => window.runtimePeers.a2.state),
    "connected",
  );
  passed("fresh API grant joins the new room generation after rotation");
  await page.evaluate(async () => {
    for (const timer of window.runtimeTimers) clearInterval(timer);
    for (const oscillator of window.runtimeOscillators) oscillator.stop();
    await window.runtimeAudioContext.close();
    await Promise.all(
      Object.values(window.runtimePeers).map((peer) => peer.disconnect()),
    );
  });
  await h.app.close();
  for (const route of ["/rtc", "/rtc/validate", "/rtc/v1", "/rtc/v1/validate"])
    assert.equal(
      (
        await request(
          rtcHost,
          route + "?access_token=" + encodeURIComponent(a2.token),
        )
      ).status,
      503,
    );
  passed("admission API outage fails closed on all four real ingress paths");
  assert.equal(receipt.mediaAccepted, true);
  assert.equal(receipt.audioAccepted, true);
  assert.equal(receipt.videoAccepted, true);
  receipt.result = "PASS_MEDIA_AND_SIGNALING";
} catch (error) {
  receipt.result = "FAIL";
  receipt.error = cleanText(error.stack || error);
  for (const [kind, name] of [
    ["livekit", names[0]],
    ["haproxy", names[1]],
  ]) {
    const log = spawnSync(
      "sudo",
      ["-n", "docker", "logs", "--tail", "25", name],
      { encoding: "utf8", timeout: 5000, maxBuffer: 131072 },
    );
    receipt[kind + "Diagnostics"] = cleanText(
      (log.stdout || "") + (log.stderr || ""),
    );
  }
  console.error("FAIL " + receipt.error);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    /* Unit teardown also owns browser descendants. */
  }
  for (const socket of browserProxySockets) socket.destroy();
  if (browserProxy) await new Promise((resolve) => browserProxy.close(resolve));
  try {
    nginx?.kill("SIGTERM");
  } catch {
    /* Already gone. */
  }
  try {
    await h?.close();
  } catch (error) {
    receipt.apiCleanupError = cleanText(error.message);
  }
  try {
    await genericCleanup();
    receipt.cleanupVerified = true;
  } catch (error) {
    receipt.cleanupVerified = false;
    receipt.cleanupError = cleanText(error.message);
    receipt.result = "FAIL";
    process.exitCode = 1;
  }
  receipt.completedAt = new Date().toISOString();
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    "RECEIPT " +
      receiptPath +
      " result=" +
      receipt.result +
      " checks=" +
      receipt.checks.length +
      " cleanup=" +
      receipt.cleanupVerified,
  );
}
process.exit(process.exitCode || 0);
