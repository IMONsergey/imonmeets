#!/usr/bin/env node
/** Read-only launch gates. No mail, payments, load tests or configuration writes. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const enabled = (value) => value === "true";
const present = (value) => typeof value === "string" && value.trim().length > 0;
const releaseFields = ["RELEASE_COMMIT", "RELEASE_IMAGE_DIGEST"];
const emailProvider = (env) => env.EMAIL_PROVIDER || "smtp";
const fields = {
  media: [
    "APP_URL",
    "LIVEKIT_URL",
    "LIVEKIT_PUBLIC_IP",
    "MAX_ACTIVE_ROOMS",
    "MAX_PARTICIPANTS_PER_ROOM",
    "MAX_ACTIVE_RECORDINGS",
    "RECORDING_ENABLED",
    "LIVEKIT_SIGNALING_AUTH_ENABLED",
    "TURN_PUBLIC_HOST",
    "TURN_TLS_PORT",
  ],
  alerts: ["APP_URL"],
  email: ["APP_URL", "EMAIL_DELIVERY_MODE", "SMTP_FROM"],
  billing: [
    "APP_URL",
    "YOOKASSA_SHOP_ID",
    "YOOKASSA_TEST_MODE",
    "YOOKASSA_VAT_CODE",
    "YOOKASSA_TAX_SYSTEM_CODE",
    "BILLING_PRO_PRICE_KOPECKS",
  ],
  recording: [
    "APP_URL",
    "LIVEKIT_URL",
    "S3_ENDPOINT",
    "S3_PUBLIC_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "RECORDING_RETENTION_DAYS",
  ],
  transcription: [
    "APP_URL",
    "ANALYSIS_WORKER_URL",
    "ANALYSIS_MODEL_MANIFEST_SHA256",
  ],
  summary: ["APP_URL", "ANALYSIS_WORKER_URL", "ANALYSIS_MODEL_MANIFEST_SHA256"],
};

/** Identifies the deployment/sender/provider without including passwords or keys. */
export function configurationHash(env, capability) {
  // Keep the old name as an API alias, never as permission to reuse a v1 receipt.
  const canonical = capability === "smtp" ? "email" : capability;
  if (!Object.hasOwn(fields, canonical)) throw new Error("UNKNOWN_CAPABILITY");
  const selected = [...releaseFields, ...fields[canonical]];
  const pairs = [
    ["evidenceSchema", "2"],
    ...selected.map((key) => [key, env[key] || ""]),
  ];
  if (canonical === "email") {
    const provider = emailProvider(env);
    pairs.push(["EMAIL_PROVIDER", provider]);
    if (provider === "smtp") {
      for (const key of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER"])
        pairs.push([key, env[key] || ""]);
    }
    // Resend has a fixed HTTPS API endpoint in the application. Keys are not fingerprints.
  }
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

export function isFresh(timestamp, now, maxAge) {
  if (typeof timestamp !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(timestamp))
    return false;
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -5 * MINUTE && age <= maxAge;
}

function accepted(env, evidence, capability, requirements, now) {
  const item =
    capability === "email"
      ? (evidence?.email ?? evidence?.smtp)
      : evidence?.[capability];
  return Boolean(
    item &&
    isFresh(item.acceptedAt, now, 30 * DAY) &&
    item.configurationHash === configurationHash(env, capability) &&
    requirements.every((name) => item[name] === true),
  );
}

/** Every returned detail is deliberately allowlisted; never spread input objects. */
export function evaluateReadiness({
  env = {},
  operations,
  mail,
  offsite,
  alerts,
  acceptance = {},
  now = Date.now(),
} = {}) {
  const healthBlockers = [];
  const publicBlockers = [];
  const commercialBlockers = [];
  const checks = {};
  const healthCurrent = Boolean(
    operations && isFresh(operations.checkedAt, now, 10 * MINUTE),
  );
  if (!healthCurrent)
    healthBlockers.push("OPERATIONS_EVIDENCE_MISSING_OR_STALE");
  for (const name of ["api", "mediaSignaling", "backup", "disk"]) {
    const ok = healthCurrent && operations?.checks?.[name]?.ok === true;
    checks[name] = { ok: Boolean(ok) };
    if (!ok)
      healthBlockers.push(
        `SERVICE_${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_NOT_HEALTHY`,
      );
  }
  // An explicit overall failure must not be hidden by a partial allowlist.
  if (healthCurrent && operations?.ok !== true)
    healthBlockers.push("OPERATIONS_REPORTED_FAILURE");
  const production =
    env.NODE_ENV === "production" || env.APP_ENV === "production";
  const releaseIdentified =
    /^[a-f0-9]{40}$/.test(env.RELEASE_COMMIT || "") &&
    /^sha256:[a-f0-9]{64}$/.test(env.RELEASE_IMAGE_DIGEST || "");
  checks.release = { identified: releaseIdentified };
  if (!releaseIdentified) publicBlockers.push("RELEASE_IDENTITY_REQUIRED");
  let secureApp = false;
  let canonicalPort = false;
  try {
    const url = new URL(env.APP_URL);
    secureApp =
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/";
    canonicalPort = secureApp && url.port === "";
  } catch {
    /* Invalid config stays unready. */
  }
  if (!production || !secureApp || enabled(env.DEV_ALLOW_UNVERIFIED_EMAIL))
    publicBlockers.push("PRODUCTION_AUTH_CONFIGURATION_REQUIRED");
  checks.canonicalHttps = { configured: canonicalPort };
  if (!canonicalPort) publicBlockers.push("CANONICAL_HTTPS_PORT_REQUIRED");
  let mediaEndpoint = false;
  let mediaPort = false;
  try {
    const url = new URL(env.LIVEKIT_URL);
    mediaEndpoint =
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
    mediaPort = mediaEndpoint && url.port === "";
  } catch {
    /* Invalid media URL stays unready. */
  }
  const mediaConfigured =
    mediaEndpoint &&
    present(env.LIVEKIT_API_KEY) &&
    present(env.LIVEKIT_API_SECRET);
  checks.mediaConfiguration = { configured: Boolean(mediaConfigured) };
  if (!mediaConfigured)
    publicBlockers.push("PUBLIC_MEDIA_CONFIGURATION_REQUIRED");
  if (!mediaPort) publicBlockers.push("PUBLIC_MEDIA_HTTPS_PORT_REQUIRED");
  const mediaAccepted = accepted(
    env,
    acceptance,
    "media",
    ["realTwoPartyCall", "externalNetwork", "targetCapacity", "turnTls443"],
    now,
  );
  checks.mediaAcceptance = { accepted: mediaAccepted };
  if (!mediaAccepted)
    publicBlockers.push(
      "EXTERNAL_MEDIA_AND_TARGET_CAPACITY_ACCEPTANCE_REQUIRED",
    );
  const alertsAccepted = accepted(
    env,
    acceptance,
    "alerts",
    ["independentMonitor", "incidentDelivery", "recoveryDelivery"],
    now,
  );
  const alertsCurrent = Boolean(
    alerts?.ok === true &&
    alerts.independentMonitor === true &&
    alerts.configurationHash === configurationHash(env, "alerts") &&
    isFresh(alerts.checkedAt, now, 10 * MINUTE),
  );
  checks.externalAlerts = { accepted: alertsAccepted, current: alertsCurrent };
  if (!alertsAccepted)
    publicBlockers.push(
      "INDEPENDENT_INCIDENT_AND_RECOVERY_DELIVERY_ACCEPTANCE_REQUIRED",
    );
  if (!alertsCurrent)
    publicBlockers.push("FRESH_INDEPENDENT_MONITOR_EVIDENCE_REQUIRED");

  const captureHost = ["mailpit", "localhost", "127.0.0.1", "::1"].includes(
    (env.SMTP_HOST || "").toLowerCase(),
  );
  const provider = emailProvider(env);
  const smtpConfigured =
    provider === "smtp" &&
    env.EMAIL_DELIVERY_MODE === "external" &&
    !captureHost &&
    present(env.SMTP_HOST) &&
    present(env.SMTP_FROM) &&
    (!present(env.SMTP_USER) || present(env.SMTP_PASSWORD));
  const resendConfigured =
    provider === "resend" &&
    env.EMAIL_DELIVERY_MODE === "external" &&
    present(env.RESEND_API_KEY) &&
    present(env.SMTP_FROM);
  const emailConfigured = smtpConfigured || resendConfigured;
  // Neither SMTP queue acceptance nor Resend API acceptance is inbox delivery.
  const delivered = Boolean(
    mail?.received === true &&
    present(mail.nonce) &&
    isFresh(mail.receivedAt, now, 30 * DAY) &&
    isFresh(mail.submittedAt, now, 30 * DAY) &&
    Date.parse(mail.receivedAt) >= Date.parse(mail.submittedAt) &&
    mail.configurationHash === configurationHash(env, "email"),
  );
  const emailAccepted =
    emailConfigured &&
    delivered &&
    accepted(
      env,
      acceptance,
      "email",
      [
        "senderAuthenticationVerified",
        "verificationFlow",
        "passwordResetFlow",
        "invitationFlow",
      ],
      now,
    );
  const registrationEnabled = env.REGISTRATION_ENABLED !== "false";
  checks.email = {
    provider: ["smtp", "resend"].includes(provider) ? provider : "unsupported",
    configured: Boolean(emailConfigured),
    inboxDeliveryVerified: delivered,
    accepted: Boolean(emailAccepted),
  };
  checks.registration = {
    enabled: registrationEnabled,
    ready: Boolean(registrationEnabled && emailConfigured && emailAccepted),
  };
  if (!emailConfigured)
    publicBlockers.push("EXTERNAL_EMAIL_CONFIGURATION_REQUIRED");
  if (!delivered) publicBlockers.push("EMAIL_INBOX_DELIVERY_EVIDENCE_REQUIRED");
  if (!emailAccepted)
    publicBlockers.push(
      "EMAIL_AUTHENTICATION_AND_ACCOUNT_FLOW_ACCEPTANCE_REQUIRED",
    );
  if (!registrationEnabled) publicBlockers.push("PUBLIC_REGISTRATION_DISABLED");

  const offsiteCurrent = Boolean(
    offsite &&
    isFresh(offsite.checkedAt, now, 2 * 60 * MINUTE) &&
    isFresh(offsite.backupCreatedAt, now, 2 * 60 * MINUTE) &&
    offsite.backupOk === true &&
    offsite.automatic === true &&
    /^[a-f0-9]{64}$/.test(offsite.verifiedSha256 || ""),
  );
  checks.offsiteDatabase = { verified: offsiteCurrent };
  if (!offsiteCurrent)
    publicBlockers.push("FRESH_AUTOMATIC_OFFSITE_DATABASE_EVIDENCE_REQUIRED");

  const recordingEnabled = enabled(env.RECORDING_ENABLED);
  const recordingConfigured =
    recordingEnabled &&
    mediaConfigured &&
    [
      "S3_BUCKET",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ].every((key) => present(env[key]));
  const recordingAccepted = accepted(
    env,
    acceptance,
    "recording",
    ["startStop", "privateDownload", "deletion", "retention", "restore"],
    now,
  );
  const recordingCopied =
    offsiteCurrent && offsite?.recordingBackup?.ok === true;
  checks.recording = {
    enabled: recordingEnabled,
    configured: Boolean(recordingConfigured),
    accepted: recordingAccepted,
    offsiteVerified: Boolean(recordingCopied),
  };
  if (recordingEnabled) {
    if (!recordingConfigured)
      publicBlockers.push("RECORDING_PRIVATE_STORAGE_CONFIGURATION_REQUIRED");
    if (!recordingAccepted)
      publicBlockers.push(
        "RECORDING_LIFECYCLE_AND_RESTORE_ACCEPTANCE_REQUIRED",
      );
    if (!recordingCopied)
      publicBlockers.push("FRESH_OFFSITE_RECORDING_EVIDENCE_REQUIRED");
    if (
      operations?.checks?.recordingStorage &&
      operations.checks.recordingStorage.ok !== true
    )
      healthBlockers.push("SERVICE_RECORDING_STORAGE_NOT_HEALTHY");
  }

  const transcriptionEnabled = enabled(env.TRANSCRIPTION_ENABLED);
  const summaryEnabled = enabled(env.AI_SUMMARY_ENABLED);
  const workerConfigured =
    present(env.ANALYSIS_WORKER_URL) &&
    (env.ANALYSIS_WORKER_SECRET || "").length >= 32 &&
    /^[a-f0-9]{64}$/.test(env.ANALYSIS_MODEL_MANIFEST_SHA256 || "");
  for (const [name, on] of [
    ["transcription", transcriptionEnabled],
    ["summary", summaryEnabled],
  ]) {
    const configured = Boolean(
      recordingConfigured &&
      workerConfigured &&
      (name !== "summary" || transcriptionEnabled),
    );
    const verified = accepted(
      env,
      acceptance,
      name,
      [
        "realRecordingProcessed",
        "qualityReviewed",
        "deletion",
        "resourceBudget",
      ],
      now,
    );
    checks[name] = { enabled: on, configured, accepted: verified };
    if (on && !configured)
      publicBlockers.push(
        `${name.toUpperCase()}_WORKER_CONFIGURATION_REQUIRED`,
      );
    if (on && !verified)
      publicBlockers.push(
        `${name.toUpperCase()}_REAL_EXECUTION_ACCEPTANCE_REQUIRED`,
      );
  }

  const billingEnabled = enabled(env.BILLING_ENABLED);
  const liveProvider = env.YOOKASSA_TEST_MODE === "false";
  const providerConfigured =
    /^\d{1,20}$/.test(env.YOOKASSA_SHOP_ID || "") &&
    (env.YOOKASSA_SECRET_KEY || "").length >= 16;
  const receiptConfigured = /^[1-9]\d*$/.test(env.YOOKASSA_VAT_CODE || "");
  const termsApproved = enabled(env.COMMERCIAL_TERMS_APPROVED);
  const billingAccepted = accepted(
    env,
    acceptance,
    "billing",
    ["paymentVerified", "cancellationVerified", "receiptVerified"],
    now,
  );
  checks.billing = {
    enabled: billingEnabled,
    providerConfigured,
    liveProvider,
    receiptConfigured,
    termsApproved,
    accepted: billingAccepted,
  };
  if (!billingEnabled) commercialBlockers.push("LIVE_BILLING_DISABLED");
  if (!providerConfigured)
    commercialBlockers.push("MERCHANT_PROVIDER_CONFIGURATION_REQUIRED");
  if (!liveProvider) commercialBlockers.push("LIVE_PAYMENT_PROVIDER_REQUIRED");
  if (!receiptConfigured)
    commercialBlockers.push("FISCAL_RECEIPT_CONFIGURATION_REQUIRED");
  if (!termsApproved)
    commercialBlockers.push("COMMERCIAL_TERMS_APPROVAL_REQUIRED");
  if (!billingAccepted)
    commercialBlockers.push(
      "PAYMENT_CANCELLATION_AND_RECEIPT_ACCEPTANCE_REQUIRED",
    );
  // Billing can be intentionally off. If offered, it must be accepted before public launch.
  if (billingEnabled) publicBlockers.push(...commercialBlockers);
  const serviceHealthy = healthBlockers.length === 0;
  const publicLaunchReady = serviceHealthy && publicBlockers.length === 0;
  return {
    checkedAt: new Date(now).toISOString(),
    scope:
      "Local configuration and recorded evidence only; no active external-service tests performed",
    serviceHealthy,
    publicLaunchReady,
    commercialLaunchReady: publicLaunchReady && commercialBlockers.length === 0,
    blockers: {
      service: [...new Set(healthBlockers)],
      publicLaunch: [...new Set(publicBlockers)],
      commercial: [...new Set(commercialBlockers)],
    },
    checks,
  };
}

async function readBounded(file, json = true) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
      return undefined;
    const text = await readFile(file, "utf8");
    return json ? JSON.parse(text) : parseEnv(text);
  } catch {
    return undefined;
  }
}

export async function main(args = process.argv.slice(2)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const options = {
    env: path.join(root, ".env"),
    "state-dir": path.join(root, "ops-state"),
  };
  let hashes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--configuration-hashes") {
      hashes = true;
      continue;
    }
    const key = args[i].replace(/^--/, "");
    if (
      !args[i].startsWith("--") ||
      !["env", "state-dir", "acceptance", "offsite", "alerts"].includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    ) {
      console.error(
        JSON.stringify({
          error: "INVALID_ARGUMENTS",
          usage:
            "check-launch-readiness.mjs [--env PATH] [--state-dir PATH] [--acceptance PATH] [--offsite PATH] [--alerts PATH] [--configuration-hashes]",
        }),
      );
      return 2;
    }
    options[key] = path.resolve(args[++i]);
  }
  const env = await readBounded(options.env, false);
  if (!env) {
    console.error(JSON.stringify({ error: "ENV_FILE_MISSING_OR_UNREADABLE" }));
    return 2;
  }
  if (hashes) {
    console.log(
      JSON.stringify({
        configurationHashes: Object.fromEntries(
          Object.keys(fields).map((key) => [key, configurationHash(env, key)]),
        ),
      }),
    );
    return 0;
  }
  const [operations, mail, acceptance, offsite, alerts] = await Promise.all([
    readBounded(path.join(options["state-dir"], "health.json")),
    readBounded(path.join(options["state-dir"], "mail-delivery-check.json")),
    readBounded(
      options.acceptance ||
        path.join(options["state-dir"], "launch-acceptance.json"),
    ),
    readBounded(
      options.offsite || path.join(options["state-dir"], "offsite-status.json"),
    ),
    readBounded(
      options.alerts || path.join(options["state-dir"], "alerts-status.json"),
    ),
  ]);
  const result = evaluateReadiness({
    env,
    operations,
    mail,
    acceptance,
    offsite,
    alerts,
  });
  console.log(JSON.stringify(result, null, 2));
  // Preview with deliberately disabled features is not an unhealthy service.
  return result.serviceHealthy ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(JSON.stringify({ error: "READINESS_CHECK_FAILED" }));
      process.exitCode = 2;
    });
}
