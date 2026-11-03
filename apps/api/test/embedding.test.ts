import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import {
  parseEmbedAllowedOrigins,
  framePolicy,
  isEmbedPath,
} from "../src/embedding.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const embedPath = "/embed/room_12345678901234567890";

test("embedding is disabled by default and origins are exact and header-safe", () => {
  assert.deepEqual(parseEmbedAllowedOrigins(), []);
  assert.deepEqual(
    parseEmbedAllowedOrigins(
      "https://example.com, https://example.com/, https://example.org:8443",
    ),
    ["https://example.com", "https://example.org:8443"],
  );
  assert.deepEqual(
    parseEmbedAllowedOrigins("http://localhost:4510,http://127.0.0.1:4511"),
    ["http://localhost:4510", "http://127.0.0.1:4511"],
  );
  for (const input of [
    "*",
    "'self'",
    "null",
    "https://*.example.com",
    "http://example.com",
    "javascript:alert(1)",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "https://example.com; frame-ancestors *",
    "https://example.com\r\nX-Test: y",
    "https://example.com,,https://example.org",
  ]) {
    assert.throws(
      () => parseEmbedAllowedOrigins(input),
      /EMBED_ALLOWED_ORIGINS/,
    );
  }
  assert.throws(
    () => parseEmbedAllowedOrigins("http://localhost:4510", true),
    /EMBED_ALLOWED_ORIGINS/,
  );
  assert.throws(
    () =>
      parseEmbedAllowedOrigins(
        Array.from(
          { length: 21 },
          (_, i) => `https://test${i}.example.com`,
        ).join(","),
      ),
    /at most 20/,
  );
});

test("only the dedicated guest document can be framed", () => {
  const allowed = ["https://example.com"];
  for (const path of [
    "/",
    "/login",
    "/join/room",
    "/settings",
    "/api/me",
    "/embed",
    "/embed/short",
    "/embed/room/login",
    "/embed/%2e%2e",
    "/embed//room",
    `/embed/${"a".repeat(129)}`,
  ]) {
    assert.equal(isEmbedPath(path), false, path);
    assert.match(framePolicy(path, allowed).policy, /frame-ancestors 'none'/);
  }
  for (const path of [embedPath, `${embedPath}/`]) {
    assert.equal(isEmbedPath(path), true);
    assert.equal(framePolicy(path, []).enabled, false);
    assert.match(
      framePolicy(path, allowed).policy,
      /^frame-ancestors https:\/\/example\.com;/,
    );
  }
});

test("Vercel keeps framing protection on account paths and proxies only guest embeds", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"),
  );
  const deny = config.routes.find(
    (route: { headers?: Record<string, string> }) =>
      route.headers?.["X-Frame-Options"] === "DENY",
  );
  const embed = config.routes.find((route: { dest?: string }) =>
    route.dest?.endsWith("/embed/$1"),
  );
  const denyPattern = new RegExp(`^${deny.src}$`);
  const embedPattern = new RegExp(`^${embed.src}$`);
  for (const path of [
    "/",
    "/login",
    "/settings",
    "/api/me",
    "/embed",
    "/embed/room/login",
  ]) {
    assert.equal(denyPattern.test(path), true, path);
    assert.equal(embedPattern.test(path), false, path);
  }
  assert.equal(denyPattern.test(embedPath), false);
  assert.equal(embedPattern.test(embedPath), true);
  assert.equal(embed.headers["Cache-Control"], "no-store");
  assert.equal(embed.transforms[0].args, "$ORIGIN_PROXY_SECRET");
});

test("guest framing is served by the authenticated origin without exposing accounts to CORS", async () => {
  const secret = "embedding-proxy-secret-with-at-least-32-characters";
  const c = loadConfig({
    DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    ORIGIN_PROXY_SECRET: secret,
    EMBED_ALLOWED_ORIGINS: "https://example.com",
  });
  const pool = new Pool({
    connectionString: c.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const app = await createApp(c, {
    pool,
    logger: false,
    limiter: { consume: async () => ({ allowed: true, retryAfter: null }) },
  });
  try {
    const denied = await app.inject({
      url: embedPath,
      headers: { accept: "text/html" },
    });
    assert.equal(denied.statusCode, 403);
    const embedded = await app.inject({
      url: embedPath,
      headers: { "x-imon-proxy-secret": secret },
    });
    assert.equal(
      embedded.statusCode,
      200,
      "Build the web app before running API tests",
    );
    assert.match(String(embedded.headers["content-type"]), /text\/html/);
    assert.match(embedded.body, /<div id="root"><\/div>/);
    assert.match(embedded.body, /src="\/assets\/[^\"]+\.js"/);
    assert.equal(embedded.headers["x-frame-options"], undefined);
    assert.match(
      String(embedded.headers["content-security-policy"]),
      /^frame-ancestors https:\/\/example\.com;/,
    );
    assert.equal(embedded.headers["cache-control"], "no-store");
    const unknownPage = await app.inject({
      url: "/no-such-page",
      headers: { accept: "text/html", "x-imon-proxy-secret": secret },
    });
    assert.equal(unknownPage.statusCode, 404);
    assert.match(String(unknownPage.headers["content-type"]), /text\/html/);
    const legalPage = await app.inject({
      url: "/privacy",
      headers: { accept: "text/html", "x-imon-proxy-secret": secret },
    });
    assert.equal(legalPage.statusCode, 200);
    const unpublishedDocument = await app.inject({
      url: "/api/public-documents/privacy",
      headers: { "x-imon-proxy-secret": secret },
    });
    assert.equal(unpublishedDocument.statusCode, 404);
    const configuration = await app.inject({
      url: "/api/config",
      headers: { "x-imon-proxy-secret": secret, origin: "https://example.com" },
    });
    assert.deepEqual(configuration.json().embedAllowedOrigins, [
      "https://example.com",
    ]);
    assert.equal(configuration.headers["x-frame-options"], "DENY");
    assert.match(
      String(configuration.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
    assert.equal(
      configuration.headers["access-control-allow-origin"],
      undefined,
    );
    for (const filename of ["embed.js", "embed-protocol.js", "index.js"]) {
      const sdk = await app.inject({ url: `/sdk/v1/${filename}` });
      assert.equal(sdk.statusCode, 200, filename);
      assert.match(
        String(sdk.headers["content-type"]),
        /(?:text|application)\/javascript/,
      );
      assert.match(sdk.body, /export (?:class|function|const)/);
      assert.equal(sdk.headers["access-control-allow-origin"], "*");
      assert.equal(sdk.headers["cache-control"], "public, max-age=300");
      assert.equal(sdk.headers["access-control-allow-credentials"], undefined);
    }
    const unrelated = await app.inject({ url: "/sdk/v1/config.json" });
    assert.equal(unrelated.headers["access-control-allow-origin"], undefined);
    const crossOriginWrite = await app.inject({
      method: "POST",
      url: "/api/rooms/room/join",
      headers: { "x-imon-proxy-secret": secret, origin: "https://example.com" },
      payload: { name: "Guest" },
    });
    assert.equal(crossOriginWrite.statusCode, 403);
    assert.equal(crossOriginWrite.json().error.code, "ORIGIN_REJECTED");
  } finally {
    await app.close();
    await pool.end();
  }
});
