import { test } from "node:test";
import assert from "node:assert/strict";
import { canInvite, canManage, canRemove, validOrigin } from "../src/policy.js";
import { loadConfig } from "../src/config.js";
import { requireBudget } from "../src/limits.js";
test("role boundaries deny escalation and owner removal", () => {
  assert.equal(canInvite("member", "member"), false);
  assert.equal(canInvite("admin", "admin"), false);
  assert.equal(canInvite("owner", "admin"), true);
  assert.equal(canRemove("owner", "owner"), false);
  assert.equal(canRemove("admin", "admin"), false);
  assert.equal(canRemove("admin", "member"), true);
  assert.equal(canManage(undefined, "guest", "guest"), false);
  assert.equal(canManage("member", "creator", "other"), false);
  assert.equal(canManage("member", "creator", "creator"), true);
});
test("origin is exact including scheme and port", () => {
  assert.equal(validOrigin(undefined, "https://meet.example"), false);
  assert.equal(
    validOrigin("https://meet.example.evil", "https://meet.example"),
    false,
  );
  assert.equal(
    validOrigin("https://meet.example", "https://meet.example"),
    true,
  );
});
test("production rejects insecure configuration and development is explicit", () => {
  assert.throws(
    () => loadConfig({ DATABASE_URL: "postgres://localhost/test" }),
    /SECRET/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        BETTER_AUTH_SECRET: "a".repeat(40),
        NODE_ENV: "production",
        SMTP_HOST: "localhost",
        SMTP_FROM: "test@example.com",
      }),
    /HTTPS/,
  );
  const c = loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    S3_ENDPOINT: "",
  });
  assert.equal(c.dev, true);
  assert.equal(c.s3.endpoint, undefined);
  assert.equal(c.mediaConfigured, false);
  assert.equal(c.recordingConfigured, false);
});
test("production capture closes registration and external SMTP requires TLS", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/test",
    APP_URL: "https://review.example.com",
    BETTER_AUTH_SECRET: "ABCdef0123456789-random-strong-secret-sample",
    NODE_ENV: "production",
    SMTP_HOST: "mailpit",
    SMTP_FROM: "review@example.com",
  };
  assert.throws(() => loadConfig(base), /capture email.*REGISTRATION_ENABLED/);
  const capture = loadConfig({ ...base, REGISTRATION_ENABLED: "false" });
  assert.equal(capture.emailDelivery, "capture");
  assert.equal(capture.dev, false);
  assert.equal(capture.emailConfigured, true);
  const external = loadConfig({
    ...base,
    EMAIL_DELIVERY_MODE: "external",
    SMTP_HOST: "smtp.example.com",
  });
  assert.equal(external.smtp.requireTLS, true);
  assert.equal(external.registrationEnabled, true);
  assert.equal(
    loadConfig({
      ...base,
      EMAIL_DELIVERY_MODE: "external",
      SMTP_HOST: "smtp.example.com",
      SMTP_SECURE: "true",
    }).smtp.requireTLS,
    false,
  );
  assert.throws(
    () => loadConfig({ ...base, EMAIL_DELIVERY_MODE: "pretend" }),
    /EMAIL_DELIVERY_MODE/,
  );
  assert.throws(
    () => loadConfig({ ...base, ORIGIN_PROXY_SECRET: "short" }),
    /ORIGIN_PROXY_SECRET/,
  );
});

test("capture mail mode refuses a non-local SMTP relay", () => {
  const development = {
    NODE_ENV: "development",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
    DATABASE_URL: "postgres://localhost/test",
    EMAIL_DELIVERY_MODE: "capture",
    SMTP_FROM: "IMON Meets <test@example.invalid>",
  };
  assert.throws(
    () => loadConfig({ ...development, SMTP_HOST: "smtp.example.invalid" }),
    /capture requires a local capture SMTP host/,
  );
  const capture = loadConfig({ ...development, SMTP_HOST: "mailpit" });
  assert.equal(capture.emailDelivery, "capture");
});

test("Google OAuth requires a complete credential pair and stays disabled by default", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/test",
    DEV_ALLOW_UNVERIFIED_EMAIL: "true",
  };
  const disabled = loadConfig(base);
  assert.equal(disabled.googleOAuthConfigured, false);
  assert.equal(disabled.google.clientId, "");
  assert.equal(disabled.google.clientSecret, "");
  assert.throws(
    () => loadConfig({ ...base, GOOGLE_CLIENT_ID: "client-id" }),
    /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
  );
  assert.throws(
    () => loadConfig({ ...base, GOOGLE_CLIENT_SECRET: "client-secret" }),
    /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/,
  );
  const enabled = loadConfig({
    ...base,
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
  });
  assert.equal(enabled.googleOAuthConfigured, true);
  assert.equal(enabled.google.clientId, "google-client-id");
  assert.equal(enabled.google.clientSecret, "google-client-secret");
});

test("Resend HTTPS configuration keeps registration closed and enforces local limits", () => {
  const external = loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    APP_URL: "https://imonmeets.vercel.app",
    BETTER_AUTH_SECRET: "ABCdef0123456789-random-strong-secret-sample",
    NODE_ENV: "production",
    REGISTRATION_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "external",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "unit-test-only-not-a-real-key",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "resend",
    SMTP_PASSWORD: "unit-test-only-not-a-real-key",
    SMTP_FROM: "no-reply@notify.imon.world",
    EMAILS_PER_DAY: "45",
    EMAILS_PER_WORKSPACE_DAY: "45",
    EMAILS_PER_30D_BUCKET: "1000",
  });
  assert.equal(external.emailDelivery, "external");
  assert.equal(external.emailProvider, "resend");
  assert.equal(external.registrationEnabled, false);
  assert.equal(external.emailConfigured, true);
  assert.equal(external.smtp.from, "no-reply@notify.imon.world");
  assert.equal(external.limits.globalEmailDaily, 45);
  assert.equal(external.limits.emailDaily, 45);
  assert.equal(external.limits.email30d, 1000);
});

test("Resend Free configuration rejects provider over-limit settings", () => {
  const base = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/test",
    APP_URL: "https://imonmeets.vercel.app",
    BETTER_AUTH_SECRET: "ABCdef0123456789-random-strong-secret-sample",
    REGISTRATION_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "external",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "unit-test-only-not-a-real-key",
    SMTP_FROM: "no-reply@notify.imon.world",
  };
  assert.throws(
    () => loadConfig({ ...base, EMAILS_PER_DAY: "46" }),
    /Resend Free local limits/,
  );
  assert.throws(
    () => loadConfig({ ...base, EMAILS_PER_30D_BUCKET: "1001" }),
    /Resend Free local limits/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        EMAIL_PROVIDER: "resend",
        EMAIL_DELIVERY_MODE: "capture",
      }),
    /requires EMAIL_DELIVERY_MODE=external/,
  );
  assert.throws(
    () => loadConfig({ ...base, RESEND_API_KEY: "" }),
    /requires RESEND_API_KEY/,
  );
});

test("Resend Free global email budget rejects the 91st message in a 24-hour window", async () => {
  let consumed = 0;
  const limiter = {
    async consume(_key: string, max: number, seconds: number) {
      consumed += 1;
      return {
        allowed: consumed <= max,
        retryAfter: consumed <= max ? null : seconds,
      };
    },
  };
  for (let i = 0; i < 45; i += 1)
    await requireBudget(limiter, "smtp:global", 45, 86400);
  await assert.rejects(
    requireBudget(limiter, "smtp:global", 45, 86400),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 429 &&
      "code" in error &&
      error.code === "RATE_LIMIT",
  );
  assert.equal(consumed, 46);
});

test("Resend Free 30-day budget rejects the 1001st message", async () => {
  let consumed = 0;
  const limiter = {
    async consume(_key: string, max: number, seconds: number) {
      consumed += 1;
      return {
        allowed: consumed <= max,
        retryAfter: consumed <= max ? null : seconds,
      };
    },
  };
  for (let i = 0; i < 1000; i += 1)
    await requireBudget(limiter, "smtp:global:30d", 1000, 30 * 86400);
  await assert.rejects(
    requireBudget(limiter, "smtp:global:30d", 1000, 30 * 86400),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 429 &&
      "code" in error &&
      error.code === "RATE_LIMIT",
  );
  assert.equal(consumed, 1001);
});
