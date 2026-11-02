# Google OAuth for IMON Meets

Google login uses the existing Better Auth instance. No second auth store or identity system is introduced.

## Private server settings

Set both values in the private runtime environment only:

    GOOGLE_CLIENT_ID=<Google OAuth client ID>
    GOOGLE_CLIENT_SECRET=<Google OAuth client secret>

The application rejects a partial pair. The public /api/config response exposes only googleOAuthConfigured: true|false; it never returns either credential. Do not put the secret in Git, browser variables, public Vercel environment variables, logs or chat.

## Exact Google Console callback

The current server APP_URL is https://imonmeets.vercel.app. With Better Auth basePath=/api/auth, the exact Authorized redirect URI is:

    https://imonmeets.vercel.app/api/auth/callback/google

Authorized JavaScript origin:

    https://imonmeets.vercel.app

If the canonical APP_URL changes, derive both entries from its HTTPS origin and update the Google OAuth client to match exactly. Do not register wildcard callback paths or ephemeral Vercel preview URLs. The Google callback path is /api/auth/callback/google; the browser post-login callbackURL is a separate same-origin application path.

## Account safety

- Google provider requires a verified email before issuing a session.
- New Google registrations follow REGISTRATION_ENABLED.
- Implicit linking is disabled. If a Google email matches an existing account, the user must first sign in to that account and explicitly link Google from Settings > Security.
- Explicit linking requires an authenticated session, a verified local email, and a verified Google email. Different email addresses are rejected.
- The API enforces the authenticated session and verified local email directly on POST /api/auth/link-social; calling the endpoint without using the UI does not bypass this check. Better Auth then enforces the provider-side verified email and same-email account-linking policy.
- Existing email/password users and sessions are not migrated or overwritten.

## External activation checklist

1. Create a Web application OAuth client in Google Cloud Console.
2. Add the exact origin and redirect URI above.
3. Store client ID and secret in the private API runtime environment.
4. Restart only the IMON Meets API service and verify public /api/config reports googleOAuthConfigured=true.
5. Test new Google user, existing same-email user rejection, explicit linking, cancellation, provider callback error, logout, and protected routes.
6. Keep email registration closed until external SMTP delivery and real email verification/recovery checks pass.

## Local OAuth protocol tests

The API test suite includes a local-only mock OpenID Connect issuer using the generic OAuth adapter. It exercises the openid email profile scope request, state cookie and callback validation, replay rejection, and the local REGISTRATION_ENABLED=false gate. This is a protocol/control-flow test only; it is not a Google OAuth end-to-end test and does not validate Google credentials, Google consent screens, production DNS, or external email delivery.
