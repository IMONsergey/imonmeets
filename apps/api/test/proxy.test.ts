import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { clientIp, proxySecretMatches } from "../src/proxy.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const secret = "private-proxy-secret-with-32-characters-minimum";
const peerIp = "127.0.0.1";

test("only authenticated proxy requests can supply a single valid client IP", () => {
  const request = {
    ip: peerIp,
    headers: { "x-forwarded-for": "203.0.113.12" } as Record<string, string>,
  };
  assert.equal(proxySecretMatches(request, secret), false);
  assert.equal(clientIp(request, secret), peerIp);
  assert.equal(clientIp(request, undefined), peerIp);
  request.headers["x-imon-proxy-secret"] = "forged";
  assert.equal(clientIp(request, secret), peerIp);
  request.headers["x-imon-proxy-secret"] = secret;
  assert.equal(proxySecretMatches(request, secret), true);
  assert.equal(clientIp(request, secret), "203.0.113.12");
  request.headers["x-forwarded-for"] = "2001:db8::1234";
  assert.equal(clientIp(request, secret), "2001:db8::1234");
  for (const invalid of [
    "",
    "203.0.113.12, 198.51.100.1",
    "spoof",
    "203.0.113.12:443",
    "fe80::1%eth0",
  ]) {
    request.headers["x-forwarded-for"] = invalid;
    assert.equal(clientIp(request, secret), peerIp);
  }
  delete request.headers["x-forwarded-for"];
  request.headers["x-real-ip"] = "203.0.113.44";
  request.headers["x-vercel-forwarded-for"] = "203.0.113.55";
  assert.equal(clientIp(request, secret), peerIp);
});

test("proxy guard rejects missing/forged secret and rate limits validated client IPs", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    ORIGIN_PROXY_SECRET: secret,
  });
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const app = await createApp(config, { pool, logger: false });
  try {
    assert.equal((await app.inject({ url: "/api/config" })).statusCode, 403);
    const forged = await app.inject({
      url: "/api/config",
      headers: {
        "x-imon-proxy-secret": "forged",
        "x-forwarded-for": "203.0.113.12",
      },
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(forged.json().error.code, "PROXY_REJECTED");
    const allowed = await app.inject({
      url: "/api/config",
      headers: { "x-imon-proxy-secret": secret },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().emailDelivery, "capture");
    // Health remains reachable without proxy credentials for the internal Docker probe.
    assert.equal((await app.inject({ url: "/api/health" })).statusCode, 503);
    const join = (ip?: string, extra: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/api/rooms/proxy-test/join",
        headers: {
          origin: config.appUrl,
          "x-imon-proxy-secret": secret,
          ...(ip ? { "x-forwarded-for": ip } : {}),
          ...extra,
        },
        payload: { name: "Review" },
      });
    for (let i = 0; i < 20; i++)
      assert.equal((await join("203.0.113.12")).statusCode, 503);
    assert.equal((await join("203.0.113.12")).statusCode, 429);
    assert.equal((await join("203.0.113.13")).statusCode, 503);
    // Missing or malformed IP uses the socket peer, never another untrusted header.
    assert.equal(
      (await join(undefined, { "x-real-ip": "203.0.113.12" })).statusCode,
      503,
    );
    assert.equal((await join("not-an-ip")).statusCode, 503);
  } finally {
    await app.close();
    await pool.end();
  }
});
