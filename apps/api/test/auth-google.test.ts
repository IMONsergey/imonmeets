import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth } from "better-auth/plugins";
import { unifiedTwoFactor } from "../src/auth-mfa.js";
import { createHmac } from "node:crypto";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const proxySecret = "local-test-proxy-secret-with-more-than-32-characters";

function testConfig(registrationEnabled = true) {
  return loadConfig({
    DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    APP_URL: "http://localhost:3540",
    ORIGIN_PROXY_SECRET: proxySecret,
    REGISTRATION_ENABLED: registrationEnabled ? "true" : "false",
    GOOGLE_CLIENT_ID: "local-test-client",
    GOOGLE_CLIENT_SECRET: "local-test-secret",
  });
}

function mockAuth(
  session: null | {
    user: { id: string; email: string; emailVerified: boolean };
  },
) {
  let handlerCalls = 0;
  let sessionCalls = 0;
  const auth = {
    api: {
      getSession: async () => {
        sessionCalls++;
        return session ? { ...session, session: { id: "test-session" } } : null;
      },
    },
    handler: async () => {
      handlerCalls++;
      return Response.json({
        url: "http://issuer.test/authorize?state=issued",
      });
    },
  } as unknown as ReturnType<typeof createAuth>;
  return { auth, calls: () => ({ handlerCalls, sessionCalls }) };
}

test("auth bridge rejects noncanonical raw HTTP paths before endpoint policy can be bypassed", async () => {
  const config = testConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const mock = mockAuth({
    user: {
      id: "local-unverified",
      email: "local@example.test",
      emailVerified: false,
    },
  });
  const app = await createApp(config, {
    pool,
    logger: false,
    auth: mock.auth,
    limiter: {
      async consume() {
        return { allowed: true, retryAfter: null };
      },
    },
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert(address && typeof address === "object");
    // app.inject and fetch normalize dot segments before the bridge sees them.
    // Send the actual path bytes over loopback, as an HTTP client can do.
    for (const path of [
      "/api/auth/./link-social",
      "/api/auth/x/../link-social",
      "/api/auth/x/../change-password",
      "/api/auth/x/../request-password-reset",
      "/api/auth/x/../send-verification-email",
      "/api/auth/x/../two-factor/disable",
      "/api/auth/x/../two-factor/verify-totp",
      "/api/auth/x/../reset-password",
      "/api/auth/%2elink-social",
      "/api/auth/%2e/link-social",
      "/api/auth/link-social/",
      "/api/auth//link-social",
      "/api/auth/\\link-social",
      "/api/auth/link-social#ignored",
    ]) {
      const payload = JSON.stringify({
        provider: "google",
        callbackURL: config.appUrl + "/settings",
      });
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const outgoing = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              method: "POST",
              path,
              headers: {
                origin: config.appUrl,
                "x-imon-proxy-secret": proxySecret,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              },
            },
            (incoming) => {
              let body = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (chunk: string) => (body += chunk));
              incoming.on("error", reject);
              incoming.on("end", () =>
                resolve({ status: incoming.statusCode!, body }),
              );
            },
          );
          outgoing.on("error", reject);
          outgoing.end(payload);
        },
      );
      assert.equal(response.status, 400, path);
      assert.equal(
        JSON.parse(response.body).error.code,
        "INVALID_AUTH_PATH",
        path,
      );
      assert.deepEqual(
        mock.calls(),
        { handlerCalls: 0, sessionCalls: 0 },
        path,
      );
    }
  } finally {
    await app.close();
    await pool.end();
  }
});

test("link-social endpoint rejects direct requests without a session or verified local email", async () => {
  for (const scenario of [
    {
      name: "anonymous direct POST",
      session: null,
      status: 401,
      code: "AUTH_REQUIRED",
    },
    {
      name: "unverified local account direct POST",
      session: {
        user: {
          id: "local-1",
          email: "local@example.test",
          emailVerified: false,
        },
      },
      status: 403,
      code: "EMAIL_NOT_VERIFIED",
    },
  ]) {
    const config = testConfig();
    const pool = new Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 100,
    });
    const mock = mockAuth(scenario.session);
    const app = await createApp(config, {
      pool,
      logger: false,
      auth: mock.auth,
      limiter: {
        async consume() {
          return { allowed: true, retryAfter: null };
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/link-social",
        headers: { origin: config.appUrl, "x-imon-proxy-secret": proxySecret },
        payload: {
          provider: "google",
          callbackURL: "http://localhost:3540/settings?section=security",
        },
      });
      assert.equal(response.statusCode, scenario.status, scenario.name);
      assert.equal(response.json().error.code, scenario.code, scenario.name);
      assert.deepEqual(
        mock.calls(),
        { handlerCalls: 0, sessionCalls: 1 },
        scenario.name,
      );
    } finally {
      await app.close();
      await pool.end();
    }
  }
});

test("link-social endpoint forwards only after server-side local email verification", async () => {
  const config = testConfig();
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const mock = mockAuth({
    user: {
      id: "local-verified",
      email: "owner@example.test",
      emailVerified: true,
    },
  });
  const app = await createApp(config, {
    pool,
    logger: false,
    auth: mock.auth,
    limiter: {
      async consume() {
        return { allowed: true, retryAfter: null };
      },
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/link-social",
      headers: { origin: config.appUrl, "x-imon-proxy-secret": proxySecret },
      payload: {
        provider: "google",
        callbackURL: "http://localhost:3540/settings?section=security",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().url,
      "http://issuer.test/authorize?state=issued",
    );
    assert.deepEqual(mock.calls(), { handlerCalls: 1, sessionCalls: 1 });
  } finally {
    await app.close();
    await pool.end();
  }
});

test("Google scope policy rejects widened signin/link requests before forwarding", async () => {
  const config = testConfig(false);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const mock = mockAuth({
    user: {
      id: "scope-user",
      email: "scope@example.test",
      emailVerified: true,
    },
  });
  const app = await createApp(config, {
    pool,
    logger: false,
    auth: mock.auth,
    limiter: {
      async consume() {
        return { allowed: true, retryAfter: null };
      },
    },
  });
  try {
    for (const url of [
      "/api/auth/sign-in/social",
      "/api/auth/sign-in/social/",
      "/api/auth/link-social",
      "/api/auth/link-social/",
    ]) {
      for (const extra of [
        { scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
        {
          scopes: [
            "openid",
            "https://www.googleapis.com/auth/calendar.readonly",
          ],
        },
        { additionalParams: { include_granted_scopes: "true" } },
        { additionalParams: { access_type: "offline" } },
        {
          additionalParams: {
            scope: "https://www.googleapis.com/auth/gmail.readonly",
          },
        },
      ]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: {
            origin: config.appUrl,
            "x-imon-proxy-secret": proxySecret,
          },
          payload: {
            provider: "google",
            callbackURL: config.appUrl + "/home",
            ...extra,
          },
        });
        assert.equal(response.statusCode, 400, url);
        assert.equal(
          response.json().error.code,
          url.endsWith("/") ? "INVALID_AUTH_PATH" : "GOOGLE_SCOPE_NOT_ALLOWED",
          url,
        );
        assert.deepEqual(mock.calls(), { handlerCalls: 0, sessionCalls: 0 });
      }
    }
  } finally {
    await app.close();
    await pool.end();
  }
});

test("Google scope policy preserves approved signin and verified linking", async () => {
  const config = testConfig(false);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  const mock = mockAuth({
    user: {
      id: "scope-user",
      email: "scope@example.test",
      emailVerified: true,
    },
  });
  const app = await createApp(config, {
    pool,
    logger: false,
    auth: mock.auth,
    limiter: {
      async consume() {
        return { allowed: true, retryAfter: null };
      },
    },
  });
  try {
    for (const url of ["/api/auth/sign-in/social", "/api/auth/link-social"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { origin: config.appUrl, "x-imon-proxy-secret": proxySecret },
        payload: {
          provider: "google",
          callbackURL: config.appUrl + "/home",
          scopes: ["openid", "email", "profile"],
          additionalParams: {},
        },
      });
      assert.equal(response.statusCode, 200, url);
    }
    assert.deepEqual(mock.calls(), { handlerCalls: 2, sessionCalls: 1 });
  } finally {
    await app.close();
    await pool.end();
  }
});

test("Google scope policy configures the real provider for identity-only grants", async () => {
  const config = testConfig(false);
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 100,
  });
  try {
    const auth = createAuth(config, pool, async () => {
      throw new Error("No email may be sent by this URL-only test");
    });
    const context = await auth.$context;
    const provider = context.socialProviders.find(
      (item) => item.id === "google",
    );
    assert(provider);
    const url = new URL(
      await provider.createAuthorizationURL({
        state: "scope-fixture-state",
        codeVerifier: "scope-fixture-verifier-".repeat(3),
        redirectURI: "https://meets.fixture.invalid/api/auth/callback/google",
      }),
    );
    assert.deepEqual(url.searchParams.get("scope")?.split(" ").sort(), [
      "email",
      "openid",
      "profile",
    ]);
    assert.equal(url.searchParams.get("include_granted_scopes"), null);
    assert.equal(url.searchParams.get("access_type"), null);
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://meets.fixture.invalid/api/auth/callback/google",
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  } finally {
    await pool.end();
  }
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}

async function createMockIssuer() {
  const usedCodes = new Set<string>();
  let issuerUrl = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://issuer.local");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: issuerUrl,
          authorization_endpoint: issuerUrl + "/authorize",
          token_endpoint: issuerUrl + "/token",
          userinfo_endpoint: issuerUrl + "/userinfo",
          jwks_uri: issuerUrl + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "email", "profile"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          grant_types_supported: ["authorization_code"],
        }),
      );
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const code = form.get("code") || "";
      if (!code || usedCodes.has(code)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      usedCodes.add(code);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "access-" + code,
          token_type: "Bearer",
          expires_in: 300,
        }),
      );
      return;
    }
    if (url.pathname === "/userinfo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          sub: "mock-subject-1",
          email: "mock-user@example.test",
          email_verified: true,
          name: "Local Mock User",
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  issuerUrl = await listen(server);
  return { server, issuerUrl };
}

function createMockOAuthAuth(
  issuerUrl: string,
  registrationEnabled: boolean,
  mfa = false,
) {
  const database: Record<string, unknown[]> & { session: unknown[] } = {
    user: [],
    session: [],
    account: [],
    verification: [],
    twoFactor: [],
  };
  const auth = betterAuth({
    appName: "IMON Meets OAuth Test Harness",
    baseURL: "http://app.local",
    basePath: "/api/auth",
    secret: "local-oauth-test-secret-with-at-least-32-characters",
    database: memoryAdapter(database),
    plugins: [
      ...(mfa ? [unifiedTwoFactor("http://app.local")] : []),
      genericOAuth({
        config: [
          {
            providerId: "local-mock",
            discoveryUrl: issuerUrl + "/.well-known/openid-configuration",
            clientId: "local-mock-client",
            clientSecret: "local-mock-secret",
            scopes: ["openid", "email", "profile"],
            requireEmailVerification: true,
            disableSignUp: !registrationEnabled,
          },
        ],
      }),
    ],
    emailAndPassword: { enabled: false },
    trustedOrigins: ["http://app.local"],
  });
  return { auth, database };
}

async function authRequest(
  auth: ReturnType<typeof createMockOAuthAuth>["auth"],
  path: string,
  init?: RequestInit,
) {
  return auth.handler(new Request("http://app.local/api/auth/" + path, init));
}

test("local mock issuer exercises OAuth state, callback and replay rejection (not Google E2E)", async () => {
  const issuer = await createMockIssuer();
  const { auth } = createMockOAuthAuth(
    issuer.issuerUrl,
    testConfig(true).registrationEnabled,
  );
  try {
    const start = await authRequest(auth, "sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "local-mock",
        callbackURL: "http://app.local/after-login",
        requestSignUp: true,
      }),
    });
    assert.equal(start.status, 200);
    const startBody = (await start.json()) as { url: string };
    const authorizeUrl = new URL(startBody.url);
    const state = authorizeUrl.searchParams.get("state");
    assert(state && state.length >= 20, "OAuth state must be generated");
    assert.equal(
      authorizeUrl.searchParams.get("client_id"),
      "local-mock-client",
    );
    assert.equal(
      authorizeUrl.searchParams.get("scope"),
      "openid email profile",
    );
    const stateCookies = start.headers.getSetCookie();
    assert(stateCookies.length > 0, "state/PKCE cookies must be set");
    const cookieHeader = stateCookies
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const callbackUrl = new URL(
      "http://app.local/api/auth/callback/local-mock",
    );
    callbackUrl.searchParams.set("code", "one-time-code");
    callbackUrl.searchParams.set("state", state);
    const callback = await auth.handler(
      new Request(callbackUrl, {
        headers: { cookie: cookieHeader },
      }),
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") || "", /after-login/);
    assert(
      callback.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("better-auth.session_token=")),
    );

    const replay = await auth.handler(
      new Request(callbackUrl, {
        headers: { cookie: cookieHeader },
      }),
    );
    assert.equal(replay.status, 302);
    assert.match(
      replay.headers.get("location") || "",
      /error=/,
      "replayed state must redirect to an OAuth error, not the success callback",
    );
    assert.equal(
      replay.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("better-auth.session_token=")),
      false,
      "replayed state must not issue a second session",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      issuer.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("local mock issuer enforces Better Auth disableSignUp even when requestSignUp is explicitly requested", async () => {
  const issuer = await createMockIssuer();
  const closedConfig = testConfig(false);
  assert.equal(closedConfig.registrationEnabled, false);
  const { auth, database } = createMockOAuthAuth(
    issuer.issuerUrl,
    closedConfig.registrationEnabled,
  );
  try {
    const start = await authRequest(auth, "sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "local-mock",
        callbackURL: "http://app.local/after-login",
        requestSignUp: true,
      }),
    });
    assert.equal(start.status, 200);
    const startBody = (await start.json()) as { url: string };
    const authorizeUrl = new URL(startBody.url);
    const state = authorizeUrl.searchParams.get("state");
    assert(state);
    const stateCookies = start.headers.getSetCookie();
    assert(stateCookies.length > 0);
    const cookieHeader = stateCookies
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const callbackUrl = new URL(
      "http://app.local/api/auth/callback/local-mock",
    );
    callbackUrl.searchParams.set("code", "signup-disabled-code");
    callbackUrl.searchParams.set("state", state);
    const callback = await auth.handler(
      new Request(callbackUrl, {
        headers: { cookie: cookieHeader },
      }),
    );
    assert.equal(callback.status, 302);
    assert.match(callback.headers.get("location") || "", /error=/);
    assert.equal(
      callback.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("better-auth.session_token=")),
      false,
      "registration-disabled callback must not issue a session",
    );
    const users = await auth.api
      .listSessions({ headers: new Headers() })
      .catch(() => []);
    assert.equal(Array.isArray(users), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      issuer.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function jar(response: Response, previous = "") {
  const values = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((v) => {
        const i = v.indexOf("=");
        return [v.slice(0, i), v.slice(i + 1)];
      }),
  );
  for (const v of response.headers.getSetCookie()) {
    const first = v.split(";")[0]!;
    const i = first.indexOf("=");
    if (first.slice(i + 1)) values.set(first.slice(0, i), first.slice(i + 1));
    else values.delete(first.slice(0, i));
  }
  return [...values].map(([k, v]) => `${k}=${v}`).join("; ");
}
function currentTotp(uri: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [
    ...new URL(uri).searchParams
      .get("secret")!
      .toUpperCase()
      .replaceAll("=", ""),
  ]
    .map((v) => alphabet.indexOf(v).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(
    (bits.match(/.{8}/g) ?? []).map((v) => Number.parseInt(v, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String(
    (mac.readUInt32BE(mac[mac.length - 1]! & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}
async function mockOAuthLogin(
  auth: ReturnType<typeof createMockOAuthAuth>["auth"],
  code: string,
  cookie = "",
  target = "/invite#token=local-invitation-intent",
) {
  const start = await authRequest(auth, "sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://app.local",
      cookie,
    },
    body: JSON.stringify({
      provider: "local-mock",
      callbackURL: "http://app.local" + target,
    }),
  });
  assert.equal(start.status, 200, await start.clone().text());
  const state = new URL((await start.json()).url).searchParams.get("state")!;
  return authRequest(
    auth,
    `callback/local-mock?code=${code}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: jar(start, cookie) } },
  );
}
async function enrolledMockOAuth() {
  const issuer = await createMockIssuer();
  try {
    const { auth, database } = createMockOAuthAuth(
      issuer.issuerUrl,
      true,
      true,
    );
    const initial = await mockOAuthLogin(auth, "enrollment");
    const cookie = jar(initial);
    const headers = {
      "content-type": "application/json",
      origin: "http://app.local",
      cookie,
    };
    await auth.api.setPassword({
      headers,
      body: { newPassword: "Local-enrollment-password-123" },
    });
    const setup = await authRequest(auth, "two-factor/enable", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "Local-enrollment-password-123" }),
    });
    assert.equal(setup.status, 200, await setup.clone().text());
    const { totpURI, backupCodes } = await setup.json();
    const verified = await authRequest(auth, "two-factor/verify-totp", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: currentTotp(totpURI), trustDevice: false }),
    });
    assert.equal(verified.status, 200, await verified.clone().text());
    database.session = [];
    return {
      auth,
      database,
      issuer,
      totpURI: totpURI as string,
      backupCodes: backupCodes as string[],
    };
  } catch (error) {
    await new Promise<void>((resolve) => issuer.server.close(() => resolve()));
    throw error;
  }
}

test("OAuth MFA holds back the full session, preserves invitation intent and consumes its challenge once", async () => {
  const h = await enrolledMockOAuth();
  try {
    const callback = await mockOAuthLogin(h.auth, "mfa-signin");
    assert.equal(
      h.database.session.length,
      0,
      "OAuth callback must delete the pre-MFA session",
    );
    assert.equal(callback.status, 302);
    const target = new URL(callback.headers.get("location")!);
    assert.equal(target.pathname, "/login");
    assert.equal(target.searchParams.get("twoFactor"), "1");
    assert.equal(
      new URLSearchParams(target.hash.slice(1)).get("returnTo"),
      "/invite#token=local-invitation-intent",
    );
    assert.ok(
      !target.search.includes("local-invitation-intent"),
      "invitation token must remain in a URL fragment",
    );
    const pending = jar(callback);
    assert.ok(!pending.includes("session_token="));
    assert.ok(pending.includes("two_factor="));
    const session = await authRequest(h.auth, "get-session", {
      headers: { cookie: pending },
    });
    assert.equal(await session.json(), null);
    const headers = {
      "content-type": "application/json",
      origin: "http://app.local",
      cookie: pending,
    };
    const denied = await authRequest(h.auth, "two-factor/verify-totp", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "000000" }),
    });
    assert.notEqual(denied.status, 200);
    assert.equal(h.database.session.length, 0);
    const accepted = await authRequest(
      h.auth,
      "two-factor/verify-backup-code",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ code: h.backupCodes[0], trustDevice: false }),
      },
    );
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.ok(jar(accepted, pending).includes("session_token="));
    const replay = await authRequest(h.auth, "two-factor/verify-backup-code", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: h.backupCodes[1], trustDevice: false }),
    });
    assert.notEqual(replay.status, 200);
    assert.equal(h.database.session.length, 1);
  } finally {
    await new Promise<void>((resolve) =>
      h.issuer.server.close(() => resolve()),
    );
  }
});

test("OAuth MFA expires pending proof and keeps protected account APIs unavailable", async () => {
  const h = await enrolledMockOAuth();
  try {
    const callback = await mockOAuthLogin(h.auth, "expired-challenge");
    const cookie = jar(callback);
    const accounts = await authRequest(h.auth, "list-accounts", {
      headers: { cookie },
    });
    assert.equal(accounts.status, 401);
    for (const value of h.database.verification as Array<{
      identifier: string;
      expiresAt: Date;
    }>) {
      if (value.identifier.startsWith("2fa-"))
        value.expiresAt = new Date(Date.now() - 60_000);
    }
    const expired = await authRequest(h.auth, "two-factor/verify-backup-code", {
      method: "POST",
      headers: {
        cookie,
        origin: "http://app.local",
        "content-type": "application/json",
      },
      body: JSON.stringify({ code: h.backupCodes[0], trustDevice: false }),
    });
    assert.notEqual(expired.status, 200);
    assert.equal(h.database.session.length, 0);
  } finally {
    await new Promise<void>((resolve) =>
      h.issuer.server.close(() => resolve()),
    );
  }
});

test("OAuth MFA trusts only a valid remembered device and challenges it after revocation", async () => {
  const h = await enrolledMockOAuth();
  try {
    const callback = await mockOAuthLogin(h.auth, "remember-first");
    const pending = jar(callback);
    const verified = await authRequest(
      h.auth,
      "two-factor/verify-backup-code",
      {
        method: "POST",
        headers: {
          cookie: pending,
          origin: "http://app.local",
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: h.backupCodes[0], trustDevice: true }),
      },
    );
    assert.equal(verified.status, 200, await verified.clone().text());
    const trusted = jar(verified, pending);
    assert.ok(trusted.includes("trust_device="));
    h.database.session = [];
    const remembered = await mockOAuthLogin(h.auth, "remember-valid", trusted);
    assert.equal(
      new URL(remembered.headers.get("location")!).pathname,
      "/invite",
    );
    assert.equal(h.database.session.length, 1);
    const rotated = jar(remembered, trusted);
    h.database.session = [];
    h.database.verification = (
      h.database.verification as Array<{ identifier: string }>
    ).filter((row) => !row.identifier.startsWith("trust-device-"));
    const revoked = await mockOAuthLogin(h.auth, "remember-revoked", rotated);
    assert.equal(
      new URL(revoked.headers.get("location")!).searchParams.get("twoFactor"),
      "1",
    );
    assert.equal(h.database.session.length, 0);
    assert.ok(!jar(revoked, rotated).includes("session_token="));
  } finally {
    await new Promise<void>((resolve) =>
      h.issuer.server.close(() => resolve()),
    );
  }
});
