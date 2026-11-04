import { betterAuth } from "better-auth";
import { unifiedTwoFactor } from "./auth-mfa.js";
import { googleOAuthProviderPolicy } from "./google-oauth-policy.js";
import type { Pool } from "pg";
import { postgresLimiter } from "./limits.js";
import type { Config } from "./config.js";
import { createMailer, MailDeliveryError } from "./mail.js";
export {
  createMailer,
  MailDeliveryError,
  resendIdempotencyKey,
} from "./mail.js";
const pendingByAuth = new WeakMap<object, Set<Promise<unknown>>>();

export async function drainAuthTasks(auth: object, deadlineMs = 25_000) {
  const pending = pendingByAuth.get(auth);
  if (!pending?.size) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs);
        timer.unref();
      }),
    ]);
    return pending.size === 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createAuth(
  c: Config,
  pool: Pool,
  transport = createMailer(c, pool),
) {
  const send = async (to: string, subject: string, text: string) => {
    try {
      await transport(to, subject, text);
    } catch (error) {
      // Preserve the same public response for existing and unknown accounts,
      // including provider failures and exhausted actual-delivery budgets.
      if (!(error instanceof MailDeliveryError)) throw error;
      console.warn(
        JSON.stringify({
          event: "auth.email_delivery_failed",
          kind: error.kind,
        }),
      );
    }
  };
  const pending = new Set<Promise<unknown>>();
  const auth = betterAuth({
    appName: "IMON Meets",
    baseURL: c.appUrl,
    basePath: "/api/auth",
    secret: c.authSecret,
    database: pool,
    plugins: [unifiedTwoFactor(c.appUrl)],
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
              ...googleOAuthProviderPolicy(),
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
      backgroundTasks: {
        handler(task) {
          // Recovery must not expose whether a provider call was necessary.
          // Keep tasks alive through graceful shutdown; the mail ledger still
          // reserves every provider attempt before any network side effect.
          const settled = task.catch(() => {
            console.error("Authentication background task failed");
          });
          pending.add(settled);
          void settled.then(() => pending.delete(settled));
        },
      },
      useSecureCookies: c.appUrl.startsWith("https://"),
      ipAddress: { ipAddressHeaders: ["x-imon-client-ip"] },
    },
  });
  pendingByAuth.set(auth, pending);
  return auth;
}
