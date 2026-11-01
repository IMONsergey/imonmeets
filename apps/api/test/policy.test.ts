import { test } from "node:test";
import assert from "node:assert/strict";
import { canInvite, canManage, canRemove, validOrigin } from "../src/policy.js";
import { loadConfig } from "../src/config.js";
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
    SMTP_HOST: "smtp.example.com",
    SMTP_FROM: "review@example.com",
  };
  assert.throws(() => loadConfig(base), /capture email.*REGISTRATION_ENABLED/);
  const capture = loadConfig({ ...base, REGISTRATION_ENABLED: "false" });
  assert.equal(capture.emailDelivery, "capture");
  assert.equal(capture.dev, false);
  assert.equal(capture.emailConfigured, true);
  const external = loadConfig({ ...base, EMAIL_DELIVERY_MODE: "external" });
  assert.equal(external.smtp.requireTLS, true);
  assert.equal(external.registrationEnabled, true);
  assert.equal(
    loadConfig({
      ...base,
      EMAIL_DELIVERY_MODE: "external",
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
