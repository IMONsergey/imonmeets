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
  return {
    dev,
    appUrl,
    authSecret,
    databaseUrl: env.DATABASE_URL,
    emailConfigured,
    mediaConfigured,
    recordingConfigured,
    port: Number(env.PORT || 3540),
    host: env.HOST || "127.0.0.1",
    registrationEnabled: env.REGISTRATION_ENABLED !== "false",
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      secure: env.SMTP_SECURE === "true",
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
      accessKey: env.S3_ACCESS_KEY_ID || "",
      secret: env.S3_SECRET_ACCESS_KEY || "",
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    },
  };
}
export type Config = ReturnType<typeof loadConfig>;
