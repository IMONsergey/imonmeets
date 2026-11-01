import { parseEmbedAllowedOrigins } from "./embedding.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const dev =
    env.NODE_ENV !== "production" && env.DEV_ALLOW_UNVERIFIED_EMAIL === "true";
  const appUrl = new URL(env.APP_URL || "http://localhost:5173").origin;
  const authSecret =
    env.BETTER_AUTH_SECRET ||
    (dev ? "development-only-change-this-secret-0123456789" : "");
  if (authSecret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must have at least 32 characters");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const originProxySecret = env.ORIGIN_PROXY_SECRET || undefined;
  if (originProxySecret && originProxySecret.length < 32)
    throw new Error("ORIGIN_PROXY_SECRET must have at least 32 characters");
  const emailDelivery = env.EMAIL_DELIVERY_MODE || "capture";
  if (emailDelivery !== "capture" && emailDelivery !== "external")
    throw new Error("EMAIL_DELIVERY_MODE must be capture or external");
  const registrationEnabled = env.REGISTRATION_ENABLED !== "false";
  const emailConfigured = Boolean(env.SMTP_HOST && env.SMTP_FROM);
  if (!dev && !emailConfigured)
    throw new Error(
      "SMTP_HOST and SMTP_FROM required; explicitly set DEV_ALLOW_UNVERIFIED_EMAIL=true for local development",
    );
  if (env.NODE_ENV === "production") {
    if (!appUrl.startsWith("https://"))
      throw new Error("Production APP_URL must use HTTPS");
    if (
      authSecret.toLowerCase().includes("development") ||
      new Set(authSecret).size < 12
    )
      throw new Error("Use a random production BETTER_AUTH_SECRET");
    if (env.LIVEKIT_API_SECRET && env.LIVEKIT_API_SECRET.length < 32)
      throw new Error(
        "Production LIVEKIT_API_SECRET must have at least 32 characters",
      );
    if (env.LIVEKIT_URL && !env.LIVEKIT_URL.startsWith("wss://"))
      throw new Error("Production LIVEKIT_URL must use WSS");
    if (emailDelivery === "capture" && registrationEnabled)
      throw new Error(
        "Production capture email requires REGISTRATION_ENABLED=false",
      );
  }
  const mediaConfigured = Boolean(
    env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET,
  );
  const recordingConfigured =
    mediaConfigured &&
    env.RECORDING_ENABLED === "true" &&
    Boolean(
      env.S3_BUCKET &&
      env.S3_ACCESS_KEY_ID &&
      env.S3_SECRET_ACCESS_KEY &&
      env.S3_REGION,
    );
  const positive = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const analysis = {
    workerUrl: env.ANALYSIS_WORKER_URL || "",
    workerSecret: env.ANALYSIS_WORKER_SECRET || "",
    enabled: env.TRANSCRIPTION_ENABLED === "true",
    summaryEnabled: env.AI_SUMMARY_ENABLED === "true",
  };
  const transcriptionConfigured =
    analysis.enabled &&
    recordingConfigured &&
    Boolean(analysis.workerUrl) &&
    analysis.workerSecret.length >= 32;
  const billing = {
    commercial:
      env.BILLING_MODE === "commercial" || env.BILLING_ENABLED === "true",
    shopId: env.YOOKASSA_SHOP_ID || "",
    secretKey: env.YOOKASSA_SECRET_KEY || "",
    testMode: env.YOOKASSA_TEST_MODE !== "false",
    amountKopecks: positive("BILLING_PRO_PRICE_KOPECKS", 149000),
    receipt: env.YOOKASSA_VAT_CODE
      ? {
          vatCode: Number(env.YOOKASSA_VAT_CODE),
          ...(env.YOOKASSA_TAX_SYSTEM_CODE
            ? { taxSystemCode: Number(env.YOOKASSA_TAX_SYSTEM_CODE) }
            : {}),
        }
      : undefined,
    freeLimits: {
      rooms: positive("BILLING_FREE_ROOMS", 20),
      members: positive("BILLING_FREE_MEMBERS", 10),
      participants: positive("BILLING_FREE_PARTICIPANTS", 25),
      activeRecordings: 1,
    },
    proLimits: {
      rooms: positive("MAX_ROOMS_PER_WORKSPACE", 200),
      members: positive("MAX_MEMBERS_PER_WORKSPACE", 100),
      participants: positive("MAX_PARTICIPANTS_PER_ROOM", 100),
      activeRecordings: positive("MAX_ACTIVE_RECORDINGS", 2),
    },
  };
  const billingConfigured =
    env.BILLING_ENABLED === "true" &&
    /^\d{1,20}$/.test(billing.shopId) &&
    billing.secretKey.length >= 16 &&
    (billing.testMode ||
      (Boolean(billing.receipt) && env.COMMERCIAL_TERMS_APPROVED === "true"));
  if (billingConfigured && billing.amountKopecks < 100)
    throw new Error("Billing amount must be at least one ruble");
  return {
    embedAllowedOrigins: parseEmbedAllowedOrigins(
      env.EMBED_ALLOWED_ORIGINS,
      env.NODE_ENV === "production",
    ),
    analysis,
    transcriptionConfigured,
    summaryConfigured: transcriptionConfigured && analysis.summaryEnabled,
    billing,
    billingConfigured,
    limits: {
      workspaces: positive("MAX_WORKSPACES_PER_USER", 10),
      rooms: positive("MAX_ROOMS_PER_WORKSPACE", 200),
      participants: positive("MAX_PARTICIPANTS_PER_ROOM", 100),
      members: positive("MAX_MEMBERS_PER_WORKSPACE", 100),
      invitations: positive("MAX_PENDING_INVITATIONS", 100),
      inviteHourly: positive("INVITATIONS_PER_USER_HOUR", 20),
      emailDaily: positive("EMAILS_PER_WORKSPACE_DAY", 100),
      globalEmailDaily: positive("EMAILS_PER_DAY", 500),
      recordings: positive("MAX_ACTIVE_RECORDINGS", 2),
      activeRooms: positive("MAX_ACTIVE_ROOMS", 20),
    },
    recordingRetentionDays: Math.min(
      365,
      positive("RECORDING_RETENTION_DAYS", 14),
    ),
    chatRetentionDays: Math.min(365, positive("CHAT_RETENTION_DAYS", 90)),
    dev,
    appUrl,
    authSecret,
    originProxySecret,
    databaseUrl: env.DATABASE_URL,
    emailConfigured,
    emailDelivery,
    mediaConfigured,
    recordingConfigured,
    port: Number(env.PORT || 3540),
    host: env.HOST || "127.0.0.1",
    registrationEnabled,
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === "true",
      requireTLS:
        env.NODE_ENV === "production" &&
        emailDelivery === "external" &&
        env.SMTP_SECURE !== "true",
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
      from: env.SMTP_FROM,
    },
    livekit: {
      url: env.LIVEKIT_URL || "",
      internalUrl:
        env.LIVEKIT_INTERNAL_URL ||
        env.LIVEKIT_URL?.replace(/^ws/, "http") ||
        "",
      apiKey: env.LIVEKIT_API_KEY || "",
      apiSecret: env.LIVEKIT_API_SECRET || "",
    },
    s3: {
      bucket: env.S3_BUCKET || "",
      region: env.S3_REGION || "us-east-1",
      endpoint: env.S3_ENDPOINT || undefined,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || undefined,
      accessKey: env.S3_ACCESS_KEY_ID || "",
      secret: env.S3_SECRET_ACCESS_KEY || "",
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
