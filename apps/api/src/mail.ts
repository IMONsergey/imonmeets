import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { postgresLimiter } from "./limits.js";
import type { Config } from "./config.js";
import { transaction } from "./db.js";
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

export type SmtpMessage = { from: string; to: string; subject: string; text: string; messageId: string };
export type SmtpSender = (mail: SmtpMessage) => Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;

export function createMailer(
  c: Config,
  pool: Pool,
  request: typeof fetch = fetch,
  smtpSend?: SmtpSender,
) {
  const transport = c.emailConfigured && c.emailProvider === "smtp" && !smtpSend
    ? nodemailer.createTransport({
        host: c.smtp.host,
        port: c.smtp.port,
        secure: c.smtp.secure,
        requireTLS: c.smtp.requireTLS,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        auth: c.smtp.user ? { user: c.smtp.user, pass: c.smtp.pass } : undefined,
      })
    : null;
  const deliverSmtp: SmtpSender | undefined = smtpSend ?? (transport ? (mail: SmtpMessage) => transport.sendMail(mail) : undefined);
  return async (to: string, subject: string, text: string) => {
      if (!c.emailConfigured || !c.smtp.from || (c.emailProvider === "resend" && !c.resendApiKey))
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
        reserved = await transaction(pool, async (db) => {
          const inserted = await db.query(
            "INSERT INTO im_email_deliveries " +
              "(idempotency_key, recipient_hash, state, provider, lease_expires_at) " +
              "VALUES ($1, $2, 'sending', $3, now()+interval '2 minutes') " +
              "ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key",
            [idempotencyKey, recipientHash, c.emailProvider],
          );
          if (!inserted.rowCount) return false;
          const limiter = postgresLimiter(pool);
          const budgets: Array<[string, number, number]> = [
            [`smtp:recipient:${recipient}`, 5, 3600],
            ["smtp:global", c.limits.globalEmailDaily, 86400],
          ];
          if (c.emailProvider === "resend")
            budgets.push(["smtp:global:30d", c.limits.email30d, 30 * 86400]);
          for (const [key, max, seconds] of budgets) {
            const result = await limiter.consume(key, max, seconds, db);
            if (!result.allowed)
              throw new MailDeliveryError("rate_limited", 429, result.retryAfter ?? undefined,
                "Email delivery budget exhausted before contacting the provider.");
          }
          return true;
        });
      } catch (error) {
        if (error instanceof MailDeliveryError) throw error;
        throw new MailDeliveryError("ledger", undefined, undefined,
          "Email delivery is blocked because the durable delivery ledger is unavailable.");
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
              "updated_at = now(), lease_expires_at = NULL, version = version+1, " +
              "delivery_status = CASE WHEN $2 = 'accepted' THEN 'accepted' ELSE 'unknown' END " +
              "WHERE idempotency_key = $1 AND state = 'sending'",
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

      if (c.emailProvider === "smtp") {
        let info: Awaited<ReturnType<SmtpSender>>;
        try {
          if (!deliverSmtp) throw new Error("SMTP unavailable");
          info = await deliverSmtp({
            from: c.smtp.from.trim(), to: recipient, subject, text,
            messageId: `<${idempotencyKey}@imonmeets.local>`,
          });
        } catch {
          await finalize("uncertain", undefined, undefined, "smtp_transport");
          throw new MailDeliveryError("uncertain", undefined, undefined,
            "SMTP delivery outcome is unresolved. No automatic retry was attempted.");
        }
        if (!info.accepted?.length || info.rejected?.length) {
          await finalize("rejected", undefined, info.messageId, "smtp_rejected");
          throw new MailDeliveryError("rejected", undefined, undefined,
            "SMTP did not accept the recipient.");
        }
        await finalize("accepted", undefined, info.messageId);
        return;
      }

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
