import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { postgresLimiter } from "./limits.js";
import type { Config } from "./config.js";
export class MailDeliveryError extends Error {
  constructor(
    public readonly kind: "rate_limited" | "uncertain" | "rejected" | "ledger",
    public readonly status: number | undefined,
    public readonly retryAfterSeconds: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

export function resendIdempotencyKey(
  from: string,
  to: string,
  subject: string,
  text: string,
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        from: from.trim(),
        to: to.trim().toLowerCase(),
        subject,
        text,
      }),
    )
    .digest("hex");
  return "imonmeets-" + digest;
}

type DeliveryLedgerRow = {
  state: "sending" | "accepted" | "uncertain" | "rate_limited" | "rejected";
  provider_id: string | null;
  http_status: number | null;
  error_kind: string | null;
  retry_after_seconds: number | null;
};

export function createMailer(
  c: Config,
  pool: Pool,
  request: typeof fetch = fetch,
) {
  if (c.emailProvider === "resend") {
    return async (to: string, subject: string, text: string) => {
      if (!c.emailConfigured || !c.resendApiKey || !c.smtp.from)
        throw new Error("Email delivery is not configured");
      const recipient = to.trim().toLowerCase();
      const idempotencyKey = resendIdempotencyKey(
        c.smtp.from,
        recipient,
        subject,
        text,
      );
      const recipientHash = createHash("sha256")
        .update(recipient)
        .digest("hex");

      let reserved = false;
      try {
        const inserted = await pool.query(
          "INSERT INTO im_email_deliveries " +
            "(idempotency_key, recipient_hash, state) " +
            "VALUES ($1, $2, 'sending') " +
            "ON CONFLICT (idempotency_key) DO NOTHING " +
            "RETURNING idempotency_key",
          [idempotencyKey, recipientHash],
        );
        reserved = (inserted.rowCount ?? 0) === 1;
      } catch {
        throw new MailDeliveryError(
          "ledger",
          undefined,
          undefined,
          "Email delivery is blocked because the durable delivery ledger is unavailable.",
        );
      }

      if (!reserved) {
        let prior: DeliveryLedgerRow | undefined;
        try {
          const result = await pool.query<DeliveryLedgerRow>(
            "SELECT state, provider_id, http_status, error_kind, " +
              "retry_after_seconds FROM im_email_deliveries " +
              "WHERE idempotency_key = $1",
            [idempotencyKey],
          );
          prior = result.rows[0];
        } catch {
          throw new MailDeliveryError(
            "ledger",
            undefined,
            undefined,
            "Email delivery is blocked because the prior delivery state cannot be read.",
          );
        }
        if (!prior)
          throw new MailDeliveryError(
            "ledger",
            undefined,
            undefined,
            "Email delivery is blocked because its prior ledger record is unavailable.",
          );
        if (prior.state === "accepted") return;
        if (prior.state === "rate_limited")
          throw new MailDeliveryError(
            "rate_limited",
            prior.http_status ?? 429,
            prior.retry_after_seconds ?? undefined,
            "This logical email was previously rate-limited. No automatic retry was attempted.",
          );
        if (prior.state === "rejected")
          throw new MailDeliveryError(
            "rejected",
            prior.http_status ?? undefined,
            undefined,
            "This logical email was previously rejected by the provider.",
          );
        throw new MailDeliveryError(
          "uncertain",
          prior.http_status ?? undefined,
          undefined,
          "A prior attempt for this logical email is unresolved. Reconcile the provider ledger before retrying.",
        );
      }

      const finalize = async (
        state: DeliveryLedgerRow["state"],
        httpStatus?: number,
        providerId?: string,
        errorKind?: string,
        retryAfterSeconds?: number,
      ) => {
        try {
          const updated = await pool.query(
            "UPDATE im_email_deliveries SET state = $2, http_status = $3, " +
              "provider_id = $4, error_kind = $5, retry_after_seconds = $6, " +
              "updated_at = now() WHERE idempotency_key = $1 AND state = 'sending'",
            [
              idempotencyKey,
              state,
              httpStatus ?? null,
              providerId ?? null,
              errorKind ?? null,
              retryAfterSeconds ?? null,
            ],
          );
          if ((updated.rowCount ?? 0) !== 1)
            throw new Error("ledger transition");
        } catch {
          throw new MailDeliveryError(
            "uncertain",
            httpStatus,
            undefined,
            "Email delivery state could not be finalized. Treat the outcome as unresolved and reconcile before retrying.",
          );
        }
      };

      let response: Response;
      try {
        response = await request("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + c.resendApiKey,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify({
            from: c.smtp.from.trim(),
            to: [recipient],
            subject,
            text,
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "AbortError" || error.name === "TimeoutError");
        await finalize("uncertain", undefined, undefined, "transport");
        throw new MailDeliveryError(
          "uncertain",
          undefined,
          undefined,
          timedOut
            ? "Email provider request timed out; delivery outcome is uncertain. Reconcile before retrying."
            : "Email provider connection failed; delivery outcome is uncertain. Reconcile before retrying.",
        );
      }
      if (response.status === 429) {
        const rawRetryAfter = response.headers.get("retry-after");
        const retryAfterSeconds =
          rawRetryAfter &&
          Number.isSafeInteger(Number(rawRetryAfter)) &&
          Number(rawRetryAfter) > 0
            ? Number(rawRetryAfter)
            : undefined;
        await finalize(
          "rate_limited",
          429,
          undefined,
          "rate_limited",
          retryAfterSeconds,
        );
        throw new MailDeliveryError(
          "rate_limited",
          429,
          retryAfterSeconds,
          "Email provider rate limit reached. No automatic retry was attempted.",
        );
      }
      if (response.status >= 500 || response.status === 408) {
        await finalize("uncertain", response.status, undefined, "provider_5xx");
        throw new MailDeliveryError(
          "uncertain",
          response.status,
          undefined,
          "Email provider returned a transient server error; delivery outcome is uncertain. Reconcile before retrying.",
        );
      }
      if (!response.ok) {
        await finalize("rejected", response.status, undefined, "provider_4xx");
        throw new MailDeliveryError(
          "rejected",
          response.status,
          undefined,
          "Email provider rejected the request (HTTP " + response.status + ").",
        );
      }
      let result: { id?: string };
      try {
        result = (await response.json()) as { id?: string };
      } catch {
        await finalize(
          "uncertain",
          response.status,
          undefined,
          "invalid_response",
        );
        throw new MailDeliveryError(
          "uncertain",
          response.status,
          undefined,
          "Email provider accepted the HTTP request but returned an unreadable response; delivery outcome is uncertain.",
        );
      }
      if (typeof result.id !== "string" || !result.id.trim()) {
        await finalize(
          "uncertain",
          response.status,
          undefined,
          "missing_provider_id",
        );
        throw new MailDeliveryError(
          "uncertain",
          response.status,
          undefined,
          "Email provider response did not contain a message ID; delivery outcome is uncertain.",
        );
      }
      await finalize("accepted", response.status, result.id);
    };
  }

  const transport = c.emailConfigured
    ? nodemailer.createTransport({
        host: c.smtp.host,
        port: c.smtp.port,
        secure: c.smtp.secure,
        requireTLS: c.smtp.requireTLS,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        auth: c.smtp.user
          ? { user: c.smtp.user, pass: c.smtp.pass }
          : undefined,
      })
    : null;
  return async (to: string, subject: string, text: string) => {
    if (!transport) throw new Error("Email delivery is not configured");
    await transport.sendMail({ from: c.smtp.from, to, subject, text });
  };
}
export function createAuth(c: Config, pool: Pool) {
  const send = createMailer(c, pool);
  return betterAuth({
    appName: "IMON Meets",
    baseURL: c.appUrl,
    basePath: "/api/auth",
    secret: c.authSecret,
    database: pool,
    plugins: [
      twoFactor({
        issuer: "IMON Meets",
        skipVerificationOnEnable: false,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 8,
          durationSeconds: 900,
        },
      }),
    ],
    trustedOrigins: [c.appUrl],
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        trustedProviders: [],
      },
    },
    ...(c.googleOAuthConfigured
      ? {
          socialProviders: {
            google: {
              clientId: c.google.clientId,
              clientSecret: c.google.clientSecret,
              requireEmailVerification: true,
              disableSignUp: !c.registrationEnabled,
            },
          },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !c.registrationEnabled,
      requireEmailVerification: !c.dev,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: c.emailConfigured
        ? async ({ user, url }) =>
            send(
              user.email,
              "Сброс пароля IMON Meets",
              `Откройте ссылку для сброса пароля: ${url}`,
            )
        : undefined,
    },
    emailVerification: {
      sendOnSignUp: !c.dev,
      autoSignInAfterVerification: true,
      sendVerificationEmail: c.emailConfigured
        ? async ({ user, url }) =>
            send(
              user.email,
              "Подтверждение почты IMON Meets",
              `Подтвердите адрес почты: ${url}`,
            )
        : undefined,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      customStorage: {
        consume: (key, rule) =>
          postgresLimiter(pool).consume(
            `better-auth:${key}`,
            rule.max,
            rule.window,
          ),
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: c.appUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-imon-client-ip"] },
    },
  });
}
