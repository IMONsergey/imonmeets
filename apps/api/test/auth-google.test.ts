import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { genericOAuth } from "better-auth/plugins";
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

function createMockOAuthAuth(issuerUrl: string, registrationEnabled: boolean) {
  const database: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    appName: "IMON Meets OAuth Test Harness",
    baseURL: "http://app.local",
    basePath: "/api/auth",
    secret: "local-oauth-test-secret-with-at-least-32-characters",
    database: memoryAdapter(database),
    plugins: [
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
