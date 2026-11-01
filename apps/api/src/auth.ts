import { betterAuth } from "better-auth";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import type { Config } from "./config.js";
export function createMailer(c: Config) {
  const transport = c.emailConfigured
    ? nodemailer.createTransport({
        host: c.smtp.host,
        port: c.smtp.port,
        secure: c.smtp.secure,
        requireTLS: c.smtp.requireTLS,
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
  const send = createMailer(c);
  return betterAuth({
    appName: "IMON Meets",
    baseURL: c.appUrl,
    basePath: "/api/auth",
    secret: c.authSecret,
    database: pool,
    trustedOrigins: [c.appUrl],
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
    rateLimit: { enabled: true, window: 60, max: 30 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    advanced: {
      useSecureCookies: c.appUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-imon-client-ip"] },
    },
  });
}
