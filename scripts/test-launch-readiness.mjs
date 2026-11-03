import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configurationHash,
  evaluateReadiness,
  isFresh,
  main,
} from "./check-launch-readiness.mjs";

const now = Date.parse("2026-11-01T15:00:00Z");
const timestamp = new Date(now - 60_000).toISOString();
function fixture() {
  const env = {
    APP_ENV: "production",
    APP_URL: "https://meet.example.test",
    RELEASE_COMMIT: "a".repeat(40),
    RELEASE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    PUBLIC_LEGAL_APPROVED: "true",
    PUBLIC_LEGAL_MANIFEST_SHA256: "c".repeat(64),
    SUPPORT_EMAIL: "support@example.test",
    REGISTRATION_ENABLED: "true",
    EMAIL_DELIVERY_MODE: "external",
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "sender",
    SMTP_PASSWORD: "smtp-secret",
    SMTP_FROM: "sender@example.test",
    LIVEKIT_URL: "wss://media.example.test",
    LIVEKIT_API_KEY: "media-key",
    LIVEKIT_API_SECRET: "media-secret",
    MAX_ACTIVE_ROOMS: "2",
    MAX_PARTICIPANTS_PER_ROOM: "8",
    RECORDING_ENABLED: "false",
    BILLING_ENABLED: "false",
    TRANSCRIPTION_ENABLED: "false",
    AI_SUMMARY_ENABLED: "false",
  };
  return {
    env,
    now,
    operations: {
      checkedAt: timestamp,
      ok: true,
      checks: {
        api: { ok: true },
        mediaSignaling: { ok: true },
        backup: { ok: true },
        disk: { ok: true },
      },
    },
    mail: {
      received: true,
      nonce: "verified-message",
      submittedAt: timestamp,
      receivedAt: timestamp,
      configurationHash: configurationHash(env, "smtp"),
    },
    acceptance: {
      legal: {
        acceptedAt: timestamp,
        configurationHash: configurationHash(env, "legal"),
        publiclyReachable: true,
        operatorVerified: true,
        dataFlowsReviewed: true,
        termsReviewed: true,
      },
      media: {
        acceptedAt: timestamp,
        configurationHash: configurationHash(env, "media"),
        realTwoPartyCall: true,
        externalNetwork: true,
        targetCapacity: true,
        turnTls443: true,
      },
      alerts: {
        acceptedAt: timestamp,
        configurationHash: configurationHash(env, "alerts"),
        independentMonitor: true,
        incidentDelivery: true,
        recoveryDelivery: true,
      },
      smtp: {
        acceptedAt: timestamp,
        configurationHash: configurationHash(env, "smtp"),
        senderAuthenticationVerified: true,
        verificationFlow: true,
        passwordResetFlow: true,
        invitationFlow: true,
      },
    },
    offsite: {
      checkedAt: timestamp,
      backupCreatedAt: timestamp,
      automatic: true,
      backupOk: true,
      verifiedSha256: "a".repeat(64),
    },
    alerts: {
      checkedAt: timestamp,
      ok: true,
      independentMonitor: true,
      configurationHash: configurationHash(env, "alerts"),
    },
  };
}

test("healthy free service does not claim commercial launch, disabled optional features do not block it", () => {
  const result = evaluateReadiness(fixture());
  assert.equal(result.serviceHealthy, true);
  assert.equal(result.publicLaunchReady, true);
  assert.equal(result.commercialLaunchReady, false);
  assert.deepEqual(result.blockers.publicLaunch, []);
  assert.ok(
    result.blockers.commercial.includes("COMMERCIAL_TERMS_APPROVAL_REQUIRED"),
  );
});

test("signaling health does not replace external media and target capacity acceptance", () => {
  for (const mutation of [
    (i) => {
      delete i.acceptance.media;
    },
    (i) => {
      i.acceptance.media.realTwoPartyCall = false;
    },
    (i) => {
      i.acceptance.media.externalNetwork = false;
    },
    (i) => {
      i.acceptance.media.targetCapacity = false;
    },
    (i) => {
      i.acceptance.media.turnTls443 = false;
    },
    (i) => {
      i.env.MAX_ACTIVE_ROOMS = "20";
    },
  ]) {
    const input = fixture();
    mutation(input);
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, true);
    assert.equal(result.publicLaunchReady, false);
    assert.ok(
      result.blockers.publicLaunch.includes(
        "EXTERNAL_MEDIA_AND_TARGET_CAPACITY_ACCEPTANCE_REQUIRED",
      ),
    );
  }
});

test("Mac-dependent notifications or unverified incident/recovery delivery do not pass independent alerts", () => {
  for (const mutation of [
    (i) => {
      delete i.acceptance.alerts;
    },
    (i) => {
      i.acceptance.alerts.independentMonitor = false;
    },
    (i) => {
      i.acceptance.alerts.incidentDelivery = false;
    },
    (i) => {
      i.acceptance.alerts.recoveryDelivery = false;
    },
  ]) {
    const input = fixture();
    mutation(input);
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, true);
    assert.equal(result.publicLaunchReady, false);
    assert.ok(
      result.blockers.publicLaunch.includes(
        "INDEPENDENT_INCIDENT_AND_RECOVERY_DELIVERY_ACCEPTANCE_REQUIRED",
      ),
    );
  }
});

test("previous alert acceptance requires a fresh working independent monitor now", () => {
  for (const mutation of [
    (i) => {
      delete i.alerts;
    },
    (i) => {
      i.alerts.ok = false;
    },
    (i) => {
      i.alerts.independentMonitor = false;
    },
    (i) => {
      i.alerts.checkedAt = "2026-11-01T13:00:00Z";
    },
    (i) => {
      i.alerts.configurationHash = "unrelated-installation";
    },
  ]) {
    const input = fixture();
    mutation(input);
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, true);
    assert.equal(result.publicLaunchReady, false);
    assert.ok(
      result.blockers.publicLaunch.includes(
        "FRESH_INDEPENDENT_MONITOR_EVIDENCE_REQUIRED",
      ),
    );
  }
});

test("captured mail with closed signup is a healthy preview, not a public launch", () => {
  const input = fixture();
  input.env.EMAIL_DELIVERY_MODE = "capture";
  input.env.SMTP_HOST = "mailpit";
  input.env.REGISTRATION_ENABLED = "false";
  const result = evaluateReadiness(input);
  assert.equal(result.serviceHealthy, true);
  assert.equal(result.publicLaunchReady, false);
  assert.ok(
    result.blockers.publicLaunch.includes("PUBLIC_REGISTRATION_DISABLED"),
  );
  assert.ok(
    result.blockers.publicLaunch.includes(
      "EXTERNAL_EMAIL_CONFIGURATION_REQUIRED",
    ),
  );
});

test("SMTP queue acceptance alone and an unrelated sender receipt cannot pass delivery", () => {
  for (const mutation of [
    (i) => {
      i.mail.received = false;
    },
    (i) => {
      delete i.mail.receivedAt;
    },
    (i) => {
      i.mail.receivedAt = "2026-11-01T14:58:00Z";
    },
    (i) => {
      i.env.SMTP_FROM = "changed@example.test";
    },
    (i) => {
      delete i.acceptance.smtp.passwordResetFlow;
    },
  ]) {
    const input = fixture();
    mutation(input);
    assert.equal(evaluateReadiness(input).publicLaunchReady, false);
  }
});

function acceptEmail(input) {
  const hash = configurationHash(input.env, "email");
  input.mail.configurationHash = hash;
  input.acceptance.email = {
    ...input.acceptance.smtp,
    configurationHash: hash,
  };
  delete input.acceptance.smtp;
}

test("Resend is configured without SMTP but still requires delivered mail and complete account flows", () => {
  const input = fixture();
  Object.assign(input.env, {
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "resend-test-key",
  });
  delete input.env.SMTP_HOST;
  delete input.env.SMTP_USER;
  delete input.env.SMTP_PASSWORD;
  let result = evaluateReadiness(input);
  assert.equal(result.checks.email.provider, "resend");
  assert.equal(result.checks.email.configured, true);
  assert.equal(result.checks.email.accepted, false);
  assert.equal(result.publicLaunchReady, false);
  assert.equal(
    result.blockers.publicLaunch.includes(
      "EXTERNAL_EMAIL_CONFIGURATION_REQUIRED",
    ),
    false,
  );
  acceptEmail(input);
  assert.equal(evaluateReadiness(input).publicLaunchReady, true);
  for (const change of [
    (i) => {
      i.mail.received = false;
    },
    (i) => {
      i.acceptance.email.invitationFlow = false;
    },
    (i) => {
      i.env.RESEND_API_KEY = "";
    },
    (i) => {
      i.env.EMAIL_DELIVERY_MODE = "capture";
    },
    (i) => {
      i.env.SMTP_FROM = "another@example.test";
    },
  ]) {
    const changed = structuredClone(input);
    change(changed);
    assert.equal(evaluateReadiness(changed).publicLaunchReady, false);
  }
});

test("provider fingerprints invalidate a different transport and never hash secrets or unused SMTP fields", () => {
  const { env } = fixture();
  const smtp = configurationHash(env, "email");
  assert.equal(configurationHash(env, "smtp"), smtp);
  assert.equal(
    configurationHash({ ...env, EMAIL_PROVIDER: "smtp" }, "email"),
    smtp,
  );
  const resendEnv = {
    ...env,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "first",
  };
  const resend = configurationHash(resendEnv, "email");
  assert.notEqual(resend, smtp);
  assert.equal(
    configurationHash(
      {
        ...resendEnv,
        RESEND_API_KEY: "rotated",
        SMTP_HOST: "irrelevant",
        SMTP_PASSWORD: "secret",
      },
      "email",
    ),
    resend,
  );
  assert.notEqual(
    configurationHash({ ...resendEnv, SMTP_FROM: "new@example.test" }, "email"),
    resend,
  );
  assert.notEqual(
    configurationHash(
      { ...resendEnv, EMAIL_DELIVERY_MODE: "capture" },
      "email",
    ),
    resend,
  );
  const input = fixture();
  input.env.EMAIL_PROVIDER = "unrecognized-private-value";
  assert.equal(evaluateReadiness(input).checks.email.provider, "unsupported");
  assert.equal(evaluateReadiness(input).checks.email.configured, false);
  assert.equal(
    JSON.stringify(evaluateReadiness(input)).includes(
      "unrecognized-private-value",
    ),
    false,
  );
});

test("exact release identity binds all capability receipts and missing identity blocks launch only", () => {
  for (const change of [
    (i) => {
      delete i.env.RELEASE_COMMIT;
    },
    (i) => {
      i.env.RELEASE_IMAGE_DIGEST = "latest";
    },
    (i) => {
      i.env.RELEASE_COMMIT = "c".repeat(40);
    },
    (i) => {
      i.env.RELEASE_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
    },
  ]) {
    const input = fixture();
    change(input);
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, true);
    assert.equal(result.publicLaunchReady, false);
    assert.equal(result.checks.email.accepted, false);
    assert.equal(result.checks.mediaAcceptance.accepted, false);
  }
});

test("ordinary HTTPS and WSS ports are required even if old nonstandard-port receipts claim success", () => {
  for (const key of ["APP_URL", "LIVEKIT_URL"]) {
    const input = fixture();
    input.env[key] =
      key === "APP_URL"
        ? "https://meet.example.test:8443"
        : "wss://media.example.test:8443";
    for (const [capability, entry] of Object.entries(input.acceptance))
      entry.configurationHash = configurationHash(input.env, capability);
    input.mail.configurationHash = configurationHash(input.env, "email");
    input.alerts.configurationHash = configurationHash(input.env, "alerts");
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, true);
    assert.equal(result.publicLaunchReady, false);
    assert.ok(
      result.blockers.publicLaunch.includes(
        key === "APP_URL"
          ? "CANONICAL_HTTPS_PORT_REQUIRED"
          : "PUBLIC_MEDIA_HTTPS_PORT_REQUIRED",
      ),
    );
  }
});

test("public recording endpoint and model manifest changes invalidate only their capability evidence", () => {
  const { env } = fixture();
  assert.notEqual(
    configurationHash(env, "recording"),
    configurationHash(
      { ...env, S3_PUBLIC_ENDPOINT: "https://downloads.example.test" },
      "recording",
    ),
  );
  assert.notEqual(
    configurationHash(env, "transcription"),
    configurationHash(
      { ...env, ANALYSIS_MODEL_MANIFEST_SHA256: "e".repeat(64) },
      "transcription",
    ),
  );
});

test("stale, future or timezone-less operations never produce a healthy service", () => {
  for (const time of [
    "2026-11-01T14:00:00Z",
    "2026-11-01T16:00:00Z",
    "2026-11-01T14:59:00",
    "invalid",
  ]) {
    const input = fixture();
    input.operations.checkedAt = time;
    assert.equal(evaluateReadiness(input).serviceHealthy, false);
  }
  assert.equal(isFresh(timestamp, now, 600_000), true);
});

test("disk failures, omitted checks and explicit aggregate failure are preserved", () => {
  for (const mutation of [
    (i) => {
      i.operations.checks.disk.ok = false;
    },
    (i) => {
      delete i.operations.checks.backup;
    },
    (i) => {
      i.operations.ok = false;
    },
  ]) {
    const input = fixture();
    mutation(input);
    const result = evaluateReadiness(input);
    assert.equal(result.serviceHealthy, false);
    assert.equal(result.publicLaunchReady, false);
  }
});

test("local dump success and a manual offsite copy are not evidence of automatic offsite recovery", () => {
  for (const mutation of [
    (i) => {
      delete i.offsite;
    },
    (i) => {
      i.offsite.automatic = false;
    },
    (i) => {
      i.offsite.backupCreatedAt = "2026-10-30T10:00:00Z";
    },
    (i) => {
      delete i.offsite.verifiedSha256;
    },
  ]) {
    const input = fixture();
    mutation(input);
    assert.ok(
      evaluateReadiness(input).blockers.publicLaunch.includes(
        "FRESH_AUTOMATIC_OFFSITE_DATABASE_EVIDENCE_REQUIRED",
      ),
    );
  }
});

test("recording enabled with credentials still requires lifecycle, restore and object-copy evidence", () => {
  const input = fixture();
  Object.assign(input.env, {
    RECORDING_ENABLED: "true",
    S3_BUCKET: "private",
    S3_REGION: "region",
    S3_ACCESS_KEY_ID: "access",
    S3_SECRET_ACCESS_KEY: "secret",
  });
  input.acceptance.media.configurationHash = configurationHash(
    input.env,
    "media",
  );
  let result = evaluateReadiness(input);
  assert.equal(result.checks.recording.configured, true);
  assert.equal(result.publicLaunchReady, false);
  assert.ok(
    result.blockers.publicLaunch.includes(
      "RECORDING_LIFECYCLE_AND_RESTORE_ACCEPTANCE_REQUIRED",
    ),
  );
  input.acceptance.recording = {
    acceptedAt: timestamp,
    configurationHash: configurationHash(input.env, "recording"),
    startStop: true,
    privateDownload: true,
    deletion: true,
    retention: true,
    restore: true,
  };
  input.offsite.recordingBackup = { ok: true };
  result = evaluateReadiness(input);
  assert.equal(result.publicLaunchReady, true);
});

test("enabled AI needs a private worker and real execution evidence", () => {
  const input = fixture();
  input.env.AI_SUMMARY_ENABLED = "true";
  const result = evaluateReadiness(input);
  assert.equal(result.publicLaunchReady, false);
  assert.ok(
    result.blockers.publicLaunch.includes(
      "SUMMARY_WORKER_CONFIGURATION_REQUIRED",
    ),
  );
  assert.ok(
    result.blockers.publicLaunch.includes(
      "SUMMARY_REAL_EXECUTION_ACCEPTANCE_REQUIRED",
    ),
  );
});

test("live billing requires separate merchant, fiscal, terms and full payment acceptance", () => {
  const input = fixture();
  Object.assign(input.env, {
    BILLING_ENABLED: "true",
    YOOKASSA_SHOP_ID: "12345",
    YOOKASSA_SECRET_KEY: "x".repeat(24),
    YOOKASSA_TEST_MODE: "false",
    YOOKASSA_VAT_CODE: "1",
    COMMERCIAL_TERMS_APPROVED: "true",
  });
  assert.equal(evaluateReadiness(input).commercialLaunchReady, false);
  input.acceptance.billing = {
    acceptedAt: timestamp,
    configurationHash: configurationHash(input.env, "billing"),
    paymentVerified: true,
    cancellationVerified: true,
    receiptVerified: true,
  };
  assert.equal(evaluateReadiness(input).commercialLaunchReady, true);
  input.env.YOOKASSA_TEST_MODE = "true";
  assert.equal(evaluateReadiness(input).commercialLaunchReady, false);
});

test("result never leaks raw configuration, evidence, secrets, email or endpoint values", () => {
  const input = fixture();
  input.operations.error = "db-secret-password";
  input.acceptance.untrusted = "untrusted-evidence-secret";
  input.offsite.destination = "private-host.example";
  const output = JSON.stringify(evaluateReadiness(input));
  for (const secret of [
    "smtp-secret",
    "media-secret",
    "sender@example.test",
    "https://meet.example.test",
    "db-secret-password",
    "untrusted-evidence-secret",
    "private-host.example",
  ])
    assert.equal(output.includes(secret), false, secret);
});

test("CLI reads bounded evidence without modifying files and handles unreadable input safely", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "imon-readiness-test-"));
  const stdout = [];
  const stderr = [];
  t.mock.method(console, "log", (value) => stdout.push(value));
  t.mock.method(console, "error", (value) => stderr.push(value));
  try {
    const input = fixture();
    input.operations.checkedAt = new Date().toISOString();
    await writeFile(
      path.join(dir, ".env"),
      Object.entries(input.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(dir, "health.json"),
      JSON.stringify(input.operations),
    );
    const before = (await readdir(dir)).sort();
    const code = await main([
      "--env",
      path.join(dir, ".env"),
      "--state-dir",
      dir,
    ]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout.at(-1)).serviceHealthy, true);
    assert.equal(JSON.parse(stdout.at(-1)).publicLaunchReady, false);
    assert.deepEqual((await readdir(dir)).sort(), before);
    const missingCode = await main([
      "--env",
      path.join(dir, "absent-secret-path"),
    ]);
    assert.equal(missingCode, 2);
    assert.equal(stderr.at(-1).includes("absent-secret-path"), false);
    assert.deepEqual(JSON.parse(stderr.at(-1)), {
      error: "ENV_FILE_MISSING_OR_UNREADABLE",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legal approval requires actual reviewed public documents and fresh exact evidence", () => {
  const input = fixture();
  delete input.env.PUBLIC_LEGAL_APPROVED;
  let result = evaluateReadiness(input);
  assert.equal(result.serviceHealthy, true);
  assert.equal(result.publicLaunchReady, false);
  assert.ok(
    result.blockers.publicLaunch.includes(
      "APPROVED_PUBLIC_DOCUMENTS_AND_SUPPORT_REQUIRED",
    ),
  );
  const changed = fixture();
  changed.env.PUBLIC_LEGAL_MANIFEST_SHA256 = "d".repeat(64);
  result = evaluateReadiness(changed);
  assert.equal(result.checks.publicDocuments.accepted, false);
  const unreviewed = fixture();
  unreviewed.acceptance.legal.dataFlowsReviewed = false;
  assert.equal(evaluateReadiness(unreviewed).publicLaunchReady, false);
});
