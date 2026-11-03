import { betterAuth } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import type { Pool } from "pg";
import { postgresLimiter } from "./limits.js";
import type { Config } from "./config.js";
import { createMailer, MailDeliveryError } from "./mail.js";
export { createMailer, MailDeliveryError, resendIdempotencyKey } from "./mail.js";
export function createAuth(c: Config, pool: Pool) {
  const transport = createMailer(c, pool);
  const send = async (to: string, subject: string, text: string) => {
    try { await transport(to, subject, text); }
    catch (error) {
      // Preserve the same public response for existing and unknown accounts,
      // including provider failures and exhausted actual-delivery budgets.
      if (!(error instanceof MailDeliveryError)) throw error;
    }
  };
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
