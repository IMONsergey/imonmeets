import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, password, responseCookie } from "./suite-harness.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 };
const mailEnv = {
  EMAIL_PROVIDER: "smtp",
  EMAIL_DELIVERY_MODE: "external",
  SMTP_HOST: "mock.example.test",
  SMTP_FROM: "noreply@example.test",
};
const newPassword = "New-local-confirmation-password-123";

async function identityHarness() {
  const sent: Array<{ to: string; text: string }> = [];
  const h = await harness(mailEnv, undefined, async (to, _subject, text) => {
    sent.push({ to, text });
  });
  async function oauthOnly(email: string) {
    const u = await h.signup(email);
    const second = await h.request("POST", "/api/auth/sign-in/email", {
      email,
      password,
    });
    assert.equal(second.statusCode, 200, second.body);
    await h.pool.query(
      'UPDATE "account" SET "providerId"=\'google\', password=NULL WHERE "userId"=$1 AND "providerId"=\'credential\'',
      [u.id],
    );
    return { ...u, second: responseCookie(second) };
  }
  function mailedToken() {
    const url = sent.at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
    assert.ok(url);
    assert.equal(
      new URL(url).search,
      "",
      "proof belongs in a fragment, not request logs",
    );
    return new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
  }
  return { ...h, sent, oauthOnly, mailedToken };
}

test(
  "OAuth-only password enrollment needs verified email and the exact initiating session",
  options,
  async () => {
    const h = await identityHarness();
    try {
      const owner = await h.oauthOnly("oauth-owner@example.test");
      const other = await h.signup("another@example.test");
      const state = await h.request(
        "GET",
        "/api/me/security",
        undefined,
        owner.cookie,
      );
      assert.equal(state.statusCode, 200, state.body);
      assert.equal(state.json().hasPassword, false);
      const requested = await h.request(
        "POST",
        "/api/me/password/request",
        {},
        owner.cookie,
      );
      assert.equal(requested.statusCode, 200, requested.body);
      assert.equal(h.sent.length, 1);
      const token = h.mailedToken();
      assert.ok(!requested.body.includes(token));
      for (const cookie of [undefined, owner.second, other.cookie]) {
        const denied = await h.request(
          "POST",
          "/api/me/password/complete",
          { token, newPassword },
          cookie,
        );
        assert.ok([401, 403].includes(denied.statusCode), denied.body);
      }
      const accepted = await h.request(
        "POST",
        "/api/me/password/complete",
        { token, newPassword },
        owner.cookie,
      );
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().reauthenticationRequired, true);
      assert.equal(
        (
          await h.pool.query(
            'SELECT count(*)::int AS n FROM "session" WHERE "userId"=$1',
            [owner.id],
          )
        ).rows[0].n,
        0,
      );
      const replay = await h.request(
        "POST",
        "/api/me/password/complete",
        { token, newPassword },
        owner.cookie,
      );
      assert.equal(replay.statusCode, 401);
      const login = await h.request("POST", "/api/auth/sign-in/email", {
        email: owner.email,
        password: newPassword,
      });
      assert.equal(login.statusCode, 200, login.body);
      const wrongStepUp = await h.request(
        "DELETE",
        "/api/me",
        { password: "wrong", confirmation: "DELETE" },
        responseCookie(login),
      );
      assert.equal(wrongStepUp.statusCode, 403);
      assert.ok(
        (await h.pool.query('SELECT id FROM "user" WHERE id=$1', [owner.id]))
          .rowCount,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "password enrollment rejects expired, unverified and reused proof without disabling MFA",
  options,
  async () => {
    const h = await identityHarness();
    try {
      const u = await h.oauthOnly("oauth-mfa@example.test");
      await h.pool.query(
        'UPDATE "user" SET "emailVerified"=false WHERE id=$1',
        [u.id],
      );
      assert.equal(
        (await h.request("POST", "/api/me/password/request", {}, u.cookie))
          .statusCode,
        403,
      );
      assert.equal(h.sent.length, 0);
      await h.pool.query(
        'UPDATE "user" SET "emailVerified"=true, "twoFactorEnabled"=true WHERE id=$1',
        [u.id],
      );
      assert.equal(
        (await h.request("POST", "/api/me/password/request", {}, u.cookie))
          .statusCode,
        200,
      );
      const expired = h.mailedToken();
      await h.pool.query(
        "UPDATE im_password_enrollments SET expires_at=now()-interval '1 second'",
      );
      assert.equal(
        (
          await h.request(
            "POST",
            "/api/me/password/complete",
            { token: expired, newPassword },
            u.cookie,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await h.request("POST", "/api/me/password/request", {}, u.cookie))
          .statusCode,
        200,
      );
      const token = h.mailedToken();
      const results = await Promise.all([
        h.request(
          "POST",
          "/api/me/password/complete",
          { token, newPassword },
          u.cookie,
        ),
        h.request(
          "POST",
          "/api/me/password/complete",
          { token, newPassword },
          u.cookie,
        ),
      ]);
      assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
      assert.ok(
        results.every((r) => [200, 401, 403].includes(r.statusCode)),
        results.map((r) => r.body).join("\n"),
      );
      assert.equal(
        (
          await h.pool.query(
            'SELECT "twoFactorEnabled" FROM "user" WHERE id=$1',
            [u.id],
          )
        ).rows[0].twoFactorEnabled,
        true,
      );
      assert.equal(
        (
          await h.pool.query(
            'SELECT count(*)::int AS n FROM "account" WHERE "userId"=$1 AND "providerId"=\'credential\'',
            [u.id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "unified MFA upgrade revokes legacy sessions once and preserves the enrolled factor",
  options,
  async () => {
    const h = await identityHarness();
    try {
      const legacy = await h.signup("legacy-mfa@example.test");
      await h.pool.query(
        'UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1',
        [legacy.id],
      );
      await h.pool.query(
        "DELETE FROM im_identity_migrations WHERE name='unified-mfa-v1'",
      );
      const { identitySchema } = await import("../src/identity-schema.js");
      await h.pool.query(identitySchema);
      assert.equal(
        (
          await h.pool.query(
            'SELECT count(*)::int AS n FROM "session" WHERE "userId"=$1',
            [legacy.id],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await h.pool.query(
            'SELECT "twoFactorEnabled" FROM "user" WHERE id=$1',
            [legacy.id],
          )
        ).rows[0].twoFactorEnabled,
        true,
      );
      const fresh = await h.signup("new-mfa@example.test");
      await h.pool.query(
        'UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1',
        [fresh.id],
      );
      await h.pool.query(identitySchema);
      assert.equal(
        (
          await h.pool.query(
            'SELECT count(*)::int AS n FROM "session" WHERE "userId"=$1',
            [fresh.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_identity_migrations WHERE name='unified-mfa-v1'",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await h.close();
    }
  },
);
