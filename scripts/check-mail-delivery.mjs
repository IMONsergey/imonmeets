#!/usr/bin/env node
// Explicit operator action; uses the application's shared durable transport.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { apiRuntime } from "./api-runtime.mjs";
import { configurationHash } from "./check-launch-readiness.mjs";

if (process.env.IMON_ENV_FILE) process.loadEnvFile(process.env.IMON_ENV_FILE);
const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--to" ||
  args[2] !== "--id" ||
  !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(args[1]) ||
  !/^[a-zA-Z0-9_-]{16,80}$/.test(args[3])
)
  throw new Error(
    "Use check-mail-delivery.mjs --to YOUR_OWN_VERIFIED_MAILBOX --id STABLE_CHECK_ID (reuse the same ID after an interrupted attempt)",
  );
const { loadConfig } = await apiRuntime("config");
const { createPool } = await apiRuntime("db");
const { createMailer, MailDeliveryError, resendIdempotencyKey } =
  await apiRuntime("mail");
const c = loadConfig(process.env);
if (!c.emailConfigured || c.emailDelivery !== "external")
  throw new Error(
    "Configure an external email sender before checking delivery",
  );
const nonce = args[3];
const recipient = args[1].trim().toLowerCase();
const subject = `IMON Meets: проверка доставки ${nonce}`;
const text = `Это проверка доставки служебных писем IMON Meets.\n\nКод проверки: ${nonce}\n\nПисьмо не содержит пароля или ссылки для входа. Если вы не запускали проверку, дополнительных действий не требуется.`;
const pool = createPool(c.databaseUrl);
try {
  await createMailer(c, pool)(recipient, subject, text);
  const key = resendIdempotencyKey(c.smtp.from, recipient, subject, text);
  const row = (
    await pool.query(
      "SELECT provider_id,created_at FROM im_email_deliveries WHERE idempotency_key=$1 AND state='accepted'",
      [key],
    )
  ).rows[0];
  if (!row) throw new Error("LEDGER_CONFIRMATION_MISSING");
  const state = resolve(process.env.MAIL_DELIVERY_CHECK_DIR || "ops-state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(state, "mail-delivery-check.json"),
    `${JSON.stringify(
      {
        nonce,
        recipient,
        provider: c.emailProvider,
        messageId: row.provider_id,
        idempotencyKey: key,
        submittedAt: row.created_at,
        configurationHash: configurationHash(process.env, "smtp"),
        received: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      submitted: true,
      deliveryVerified: false,
      nonce,
      next: "Verify this exact nonce in the destination inbox and inspect authentication headers. Provider acceptance alone does not prove delivery. Registration was not changed.",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      submitted: false,
      deliveryVerified: false,
      error:
        error instanceof MailDeliveryError
          ? error.kind
          : "DELIVERY_CHECK_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
