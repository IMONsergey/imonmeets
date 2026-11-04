import assert from "node:assert/strict";
import test from "node:test";
import {
  googleOAuthProviderPolicy,
  googleOAuthRequestAllowed,
} from "../apps/api/src/google-oauth-policy.ts";

test("Google requests retain only approved identity permissions", () => {
  for (const scopes of [
    undefined,
    [],
    ["openid"],
    ["email", "profile"],
    ["openid", "email", "profile"],
  ]) {
    assert.equal(
      googleOAuthRequestAllowed({ provider: "google", scopes }),
      true,
    );
  }
  assert.equal(
    googleOAuthRequestAllowed({
      provider: "google",
      callbackURL: "https://meets.fixture.invalid/home",
    }),
    true,
  );
});

test("the auth bridge rejects caller scope expansion before the provider can build a URL", () => {
  for (const scopes of [
    ["https://www.googleapis.com/auth/drive.readonly"],
    ["openid", "https://www.googleapis.com/auth/calendar.readonly"],
    [
      "email",
      "profile",
      "openid",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    ["OpenID"],
    ["openid "],
    [null],
    [1],
    "openid email profile",
    null,
    {},
  ]) {
    assert.equal(
      googleOAuthRequestAllowed({ provider: "google", scopes }),
      false,
    );
  }
});

test("caller OAuth parameters cannot widen grants or request offline access", () => {
  for (const additionalParams of [
    { include_granted_scopes: "true" },
    { access_type: "offline" },
    { scope: "https://www.googleapis.com/auth/drive.readonly" },
    { prompt: "consent" },
    { redirect_uri: "https://other.fixture.invalid/callback" },
    { unknown: "value" },
    null,
    [],
    "value",
  ]) {
    assert.equal(
      googleOAuthRequestAllowed({ provider: "google", additionalParams }),
      false,
    );
  }
  assert.equal(
    googleOAuthRequestAllowed({ provider: "google", additionalParams: {} }),
    true,
  );
});

test("provider configuration fixes minimal scopes and disables incremental grants", () => {
  assert.deepEqual(googleOAuthProviderPolicy(), {
    disableDefaultScope: true,
    scope: ["openid", "email", "profile"],
    includeGrantedScopes: false,
  });
  const modified = googleOAuthProviderPolicy();
  modified.scope.push("https://www.googleapis.com/auth/drive.readonly");
  assert.deepEqual(googleOAuthProviderPolicy().scope, [
    "openid",
    "email",
    "profile",
  ]);
  assert.equal(
    googleOAuthRequestAllowed({ provider: "google", scopes: modified.scope }),
    false,
  );
});

test("normal Google signin and explicit linking payloads stay valid", () => {
  const signIn = {
    provider: "google",
    callbackURL: "https://meets.fixture.invalid/home",
    errorCallbackURL: "https://meets.fixture.invalid/login",
    requestSignUp: false,
  };
  const link = {
    provider: "google",
    callbackURL: "https://meets.fixture.invalid/settings/security",
    errorCallbackURL: "https://meets.fixture.invalid/settings/security",
  };
  assert.equal(googleOAuthRequestAllowed(signIn), true);
  assert.equal(googleOAuthRequestAllowed(link), true);
  assert.equal(Object.hasOwn(signIn, "scopes"), false);
  assert.equal(Object.hasOwn(link, "additionalParams"), false);
});

test("unrelated auth requests retain their existing provider-specific validation", () => {
  for (const body of [
    undefined,
    null,
    {},
    [],
    { email: "fixture@example.invalid" },
    {
      provider: "mock-oidc",
      scopes: ["fixture"],
      additionalParams: { test: "fixture" },
    },
  ]) {
    assert.equal(googleOAuthRequestAllowed(body), true);
  }
});
