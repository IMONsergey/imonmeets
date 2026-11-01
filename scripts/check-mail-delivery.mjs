#!/usr/bin/env node
// Run inside the application's private environment. Never prints SMTP credentials.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer from "nodemailer";

if (process.env.IMON_ENV_FILE) process.loadEnvFile(process.env.IMON_ENV_FILE);
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--to" ||
  !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(args[1])
)
  throw new Error("Use check-mail-delivery.mjs --to YOUR_OWN_VERIFIED_MAILBOX");
if (
  process.env.EMAIL_DELIVERY_MODE !== "external" ||
  !process.env.SMTP_HOST ||
  !process.env.SMTP_FROM
)
  throw new Error("Configure an external SMTP sender before checking delivery");
const port = Number(process.env.SMTP_PORT || 587);
if (![465, 587, 2525, 2465, 2587, 25].includes(port))
  throw new Error("Use a documented TLS SMTP provider port");
const secure = process.env.SMTP_SECURE === "true";
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure,
  requireTLS: !secure,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 20000,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
});
const nonce = randomUUID();
try {
  await transport.verify();
  const result = await transport.sendMail({
    from: process.env.SMTP_FROM,
    to: args[1],
    subject: `IMON Meets: проверка доставки ${nonce}`,
    text: `Это проверка доставки служебных писем IMON Meets.\n\nКод проверки: ${nonce}\n\nПисьмо не содержит пароля или ссылки для входа. Если вы не запускали проверку, дополнительных действий не требуется.`,
  });
  if (!result.accepted?.length || result.rejected?.length)
    throw new Error("SMTP did not accept the recipient");
  const state = resolve(process.env.MAIL_DELIVERY_CHECK_DIR || "ops-state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(state, "mail-delivery-check.json"),
    `${JSON.stringify({ nonce, recipient: args[1], messageId: result.messageId, submittedAt: new Date().toISOString(), received: false }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      submitted: true,
      deliveryVerified: false,
      nonce,
      next: "Verify this exact nonce in the destination inbox and inspect authentication headers. SMTP acceptance alone does not prove delivery. Registration was not changed.",
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      submitted: false,
      deliveryVerified: false,
      error: ["EAUTH", "ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(
        error?.code,
      )
        ? error.code
        : "DELIVERY_CHECK_FAILED",
    }),
  );
  process.exitCode = 1;
} finally {
  transport.close();
}
