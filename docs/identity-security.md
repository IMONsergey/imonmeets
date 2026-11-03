# Google sign-in, local MFA and sensitive confirmation

## Decisions

IMON Meets uses the same local TOTP/backup-code challenge for password and Google/OAuth sign-in. Better Auth 1.7.14 gates credential endpoints by default, so `unifiedTwoFactor` extends the existing plugin hook to OAuth callbacks, direct social sign-in and email-verification sign-in. It preserves the library's challenge consumption, lockout and remembered-device checks. It deletes the provisional authenticated session and strips its cookie before returning a pending challenge. Redirect flows open `/login?twoFactor=1`; a same-origin continuation is carried only in the URL fragment and passed through the client's existing return-path allowlist. Invitation tokens are never moved into the login query string.

A remembered device may bypass another TOTP prompt only through Better Auth's signed cookie plus its matching, unexpired server record. Revocation, a missing record or an invalid challenge cannot create a session. Existing protected APIs continue to require an authenticated session.

Google-only users explicitly add an IMON Meets password before password-confirmed operations. The UI offers a link to the account's verified email, without asking for a nonexistent old password. The link contains 256 bits of randomness, expires after 15 minutes, is stored only as a SHA-256 digest, and is bound to the initiating user, exact session ID and verified email. Anonymous users, another user, another session of the same user, expired/replaced links and replay are rejected. Completion consumes the proof before calling the supported server-only `auth.api.setPassword`; a failed/interrupted completion requires a new proof. No public Better Auth set-password endpoint is exposed.

After adding a password, every session, pending enrollment, pending MFA challenge and remembered-device grant for that user is revoked. The enrolled TOTP secret and encrypted backup codes are preserved. The user signs in again and confirms account deletion, workspace deletion or ownership transfer with the new password. There is no fresh-session-only bypass of these actions.

## Upgrade behavior

The `unified-mfa-v1` migration marker causes a one-time revocation of existing sessions and MFA/trusted-device grants for users who already have local MFA enabled. This removes sessions that an earlier OAuth implementation might have issued without a second factor. The migration preserves enrolled factors and credentials. Restarting the fixed application does not revoke newly created sessions again.

## Primary implementation references

- Better Auth official two-factor documentation: https://better-auth.com/docs/plugins/2fa (credential-only default and custom-hook extension).
- Better Auth official accounts documentation: https://better-auth.com/docs/concepts/users-accounts (server-only setPassword for OAuth accounts).
- Pinned installed 1.7.14 sources inspected: `dist/plugins/two-factor/index.mjs`, `verify-two-factor.mjs`, `dist/api/routes/update-user.mjs`, `callback.mjs`, and `dist/api/dispatch.mjs`.

This is a deliberate verified-email recovery path using the supported server API. `allowPasswordless` was not enabled as a substitute for fresh confirmation, and local MFA is not disabled for Google.

## Validation scope

Tests use a loopback mock OAuth issuer, intercepted browser requests, synthetic credentials and isolated PostgreSQL schemas. No real Google account, production database or external email transport is used. Negative cases include provisional-session/cookie absence, protected account API refusal before MFA, invalid/expired/replayed challenge, valid and revoked remembered devices, retained invitation intent, email verification, exact-session binding, password-proof races and preservation of the enrolled factor. Production Google OAuth consent/redirect setup and real inbox acceptance remain separate deployment gates.
