import { twoFactor } from "better-auth/plugins";
import { createAuthMiddleware } from "better-auth/api";

// Better Auth 1.7.14 deliberately gates credential sign-in by default. Extend
// its supported plugin hook, retaining its atomic challenge consumption,
// account lockout, encrypted backup codes and remembered-device checks.
export function unifiedTwoFactor(appUrl: string) {
  const plugin = twoFactor({
    issuer: "IMON Meets",
    skipVerificationOnEnable: false,
    backupCodeOptions: { storeBackupCodes: "encrypted" },
    accountLockout: {
      enabled: true,
      maxFailedAttempts: 8,
      durationSeconds: 900,
    },
  });
  const challenge = plugin.hooks.after[0]!;
  const redirectFlow = (path: string) =>
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2/callback/") ||
    path === "/verify-email";
  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      after: [
        {
          ...challenge,
          matcher: (ctx: Parameters<typeof challenge.matcher>[0]) =>
            challenge.matcher(ctx) ||
            redirectFlow(ctx.path ?? "") ||
            ctx.path === "/sign-in/social",
        },
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (
              !returned ||
              typeof returned !== "object" ||
              !("twoFactorRedirect" in returned) ||
              returned.twoFactorRedirect !== true
            )
              return;
            // Remove even the now-revoked provisional cookie from the wire.
            // Preserve only deletion cookies and the signed pending challenge.
            const responseHeaders = ctx.context.responseHeaders;
            const names = [
              ctx.context.authCookies.sessionToken.name,
              ctx.context.authCookies.sessionData.name,
              ctx.context.authCookies.accountData.name,
            ];
            if (responseHeaders) {
              const cookies = responseHeaders
                .getSetCookie()
                .filter((cookie) => {
                  const name = cookie.slice(0, cookie.indexOf("="));
                  return (
                    !names.some(
                      (n) => name === n || name.startsWith(n + "."),
                    ) || /Max-Age=0(?:;|$)/i.test(cookie)
                  );
                });
              responseHeaders.delete("set-cookie");
              for (const cookie of cookies)
                responseHeaders.append("set-cookie", cookie);
            }
            if (!redirectFlow(ctx.path ?? "")) return;
            const login = new URL("/login", appUrl);
            login.searchParams.set("twoFactor", "1");
            const destination = responseHeaders?.get("location");
            if (destination) {
              try {
                const target = new URL(destination, appUrl);
                if (target.origin === new URL(appUrl).origin)
                  login.hash = new URLSearchParams({
                    returnTo: target.pathname + target.search + target.hash,
                  }).toString();
              } catch {
                /* Keep the already stored client intent. */
              }
            }
            throw ctx.redirect(login.toString());
          }),
        },
      ],
    },
  };
}
