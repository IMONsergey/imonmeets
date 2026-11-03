import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import {
  canonicalPublicJson,
  legalEdition,
  loadPublicInformation,
} from "../src/public-information.js";
import { legalAcceptanceNeeded } from "../src/legal-consent.js";
import { legalConsentSchema } from "../src/legal-consent-schema.js";
import { harness, password } from "./suite-harness.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
async function edition(
  t: TestContext,
  version = "synthetic-v1",
  text = "Synthetic approved text for isolated tests only.",
) {
  const directory = await mkdtemp(join(tmpdir(), "imon-legal-consent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const document = {
    title: "Synthetic document",
    sections: [{ heading: "Synthetic section", paragraphs: [text] }],
  };
  const documents = {
    schema: 1,
    version,
    publishedAt: "2026-01-01T00:00:00Z",
    operator: {
      name: "Synthetic test operator",
      registration: "not a real registration",
      address: "test fixture only",
    },
    terms: document,
    privacy: { ...document, title: "Synthetic privacy notice" },
  };
  const raw = JSON.stringify(documents),
    file = join(directory, "approved.json");
  await writeFile(file, raw, { mode: 0o600 });
  const env = {
    SUPPORT_EMAIL: "support@example.test",
    PUBLIC_LEGAL_APPROVED: "true",
    PUBLIC_LEGAL_MANIFEST_PATH: file,
    PUBLIC_LEGAL_MANIFEST_SHA256: createHash("sha256")
      .update(raw)
      .digest("hex"),
  };
  return { documents, env, information: loadPublicInformation(env) };
}
async function fixture(t: TestContext, required = false) {
  const e = await edition(t);
  const h = await harness({
    ...e.env,
    LEGAL_ACCEPTANCE_REQUIRED: String(required),
  });
  t.after(() => h.close());
  return { h, ...e };
}
function acceptance(information: ReturnType<typeof loadPublicInformation>) {
  const current = legalEdition(information);
  assert.ok(current);
  const { publishedAt: omitted, ...binding } = current;
  return { ...binding, termsAccepted: true, privacyAcknowledged: true };
}

test("legal enforcement is explicit, requires approved publication, and preserves exit/privacy actions", () => {
  assert.equal(loadPublicInformation({}).acceptanceRequired, false);
  assert.throws(
    () => loadPublicInformation({ LEGAL_ACCEPTANCE_REQUIRED: "yes" }),
    /must be true or false/,
  );
  assert.throws(
    () => loadPublicInformation({ LEGAL_ACCEPTANCE_REQUIRED: "true" }),
    /approved published/,
  );
  for (const [method, path] of [
    ["GET", "/api/me"],
    ["GET", "/api/me/export"],
    ["DELETE", "/api/me"],
    ["DELETE", "/api/workspaces/w"],
    ["POST", "/api/sessions/revoke-others"],
    ["POST", "/api/workspaces/w/transfer-ownership"],
    ["POST", "/api/workspaces/w/rooms/r/close"],
    ["POST", "/api/workspaces/w/recordings/r/stop"],
  ])
    assert.equal(
      legalAcceptanceNeeded(method!, path!),
      false,
      method + " " + path,
    );
  for (const [method, path] of [
    ["POST", "/api/workspaces"],
    ["POST", "/api/rooms/slug/join"],
    ["POST", "/api/workspaces/w/payments"],
    ["PATCH", "/api/workspaces/w/rooms/r"],
  ])
    assert.equal(
      legalAcceptanceNeeded(method!, path!),
      true,
      method + " " + path,
    );
});

test(
  "publication, signup, login and status reads never create legal acceptance evidence",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, documents } = await fixture(t);
    const user = await h.signup("no-implicit-consent@example.test");
    const read = await h.request(
      "GET",
      "/api/me/legal-consent",
      undefined,
      user.cookie,
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().accepted, false);
    assert.deepEqual(read.json().documents, documents);
    const me = await h.request("GET", "/api/me", undefined, user.cookie);
    assert.equal(me.json().legalConsent.accepted, false);
    for (const kind of ["terms", "privacy"]) {
      const response = await h.request("GET", "/api/public-documents/" + kind);
      assert.equal(response.statusCode, 200, response.body);
      const { documentSha256, manifestSha256, ...content } = response.json();
      assert.equal(
        documentSha256,
        createHash("sha256").update(canonicalPublicJson(content)).digest("hex"),
      );
      assert.equal(manifestSha256, h.c.publicInformation.manifestSha256);
      assert.equal(documentSha256, read.json().current[kind + "Sha256"]);
    }
    await h.request("POST", "/api/auth/sign-in/email", {
      email: user.email,
      password,
    });
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_legal_acceptances",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await h.pool.query("SELECT count(*)::int AS n FROM im_legal_versions"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/workspaces",
          { name: "Compatibility without enforcement" },
          user.cookie,
        )
      ).statusCode,
      200,
    );
  },
);

test(
  "explicit acceptance is immutable, exactly version-bound and concurrently idempotent",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, information, documents } = await fixture(t);
    const user = await h.signup("explicit-consent@example.test");
    const before = Date.now(),
      body = acceptance(information);
    const responses = await Promise.all([
      h.request("POST", "/api/me/legal-consent", body, user.cookie),
      h.request("POST", "/api/me/legal-consent", body, user.cookie),
    ]);
    for (const response of responses)
      assert.equal(response.statusCode, 200, response.body);
    const receipt = responses[0]!.json().receipt;
    assert.deepEqual(responses[1]!.json().receipt, receipt);
    assert.ok(
      Date.parse(receipt.acceptedAt) >= before - 1000 &&
        Date.parse(receipt.acceptedAt) <= Date.now() + 1000,
    );
    assert.equal(receipt.termsAccepted, true);
    assert.equal(receipt.privacyAcknowledged, true);
    assert.equal(receipt.evidenceSchema, "explicit-account-v1");
    assert.equal(receipt.manifestSha256, information.manifestSha256);
    const repeat = await h.request(
      "POST",
      "/api/me/legal-consent",
      body,
      user.cookie,
    );
    assert.deepEqual(
      repeat.json().receipt,
      receipt,
      "retries never shift the original server timestamp",
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_legal_acceptances",
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(
      (await h.pool.query("SELECT documents FROM im_legal_versions")).rows[0]
        .documents,
      documents,
    );
    await assert.rejects(
      () =>
        h.pool.query(
          "UPDATE im_legal_acceptances SET accepted_at=now()-interval '1 day'",
        ),
      /immutable/,
    );
    await assert.rejects(
      () => h.pool.query("UPDATE im_legal_versions SET version='forged'"),
      /immutable/,
    );
    await h.pool.query(legalConsentSchema);
    assert.equal(
      (
        await h.request("GET", "/api/me/legal-consent", undefined, user.cookie)
      ).json().receipt.acceptedAt,
      receipt.acceptedAt,
      "a repeated migration cannot rewrite evidence",
    );
  },
);

test(
  "missing actions, invented versions/hashes, user/time injection and CSRF never record agreement",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, information } = await fixture(t);
    const user = await h.signup("consent-negative@example.test"),
      body = acceptance(information);
    for (const invalid of [
      { ...body, termsAccepted: false },
      { ...body, privacyAcknowledged: false },
      { ...body, userId: "somebody-else" },
      { ...body, acceptedAt: "2000-01-01T00:00:00Z" },
    ])
      assert.equal(
        (await h.request("POST", "/api/me/legal-consent", invalid, user.cookie))
          .statusCode,
        400,
      );
    for (const key of [
      "manifestSha256",
      "termsSha256",
      "privacySha256",
      "version",
    ]) {
      const response = await h.request(
        "POST",
        "/api/me/legal-consent",
        { ...body, [key]: key === "version" ? "stale-v0" : "0".repeat(64) },
        user.cookie,
      );
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, "LEGAL_VERSION_CHANGED");
    }
    const csrf = await h.request(
      "POST",
      "/api/me/legal-consent",
      body,
      user.cookie,
      { origin: "https://untrusted.example.test" },
    );
    assert.equal(csrf.statusCode, 403);
    assert.equal(csrf.json().error.code, "ORIGIN_REJECTED");
    assert.equal(
      (await h.request("POST", "/api/me/legal-consent", body)).statusCode,
      401,
    );
    await h.pool.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1', [
      user.id,
    ]);
    assert.equal(
      (await h.request("POST", "/api/me/legal-consent", body, user.cookie))
        .statusCode,
      403,
    );
    await h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [
      user.id,
    ]);
    await h.pool.query('DELETE FROM "session" WHERE "userId"=$1', [user.id]);
    assert.equal(
      (await h.request("POST", "/api/me/legal-consent", body, user.cookie))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_legal_acceptances",
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  "required account business actions are checked on the server and another user's receipt never applies",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, information } = await fixture(t, true);
    const owner = await h.signup("required-owner@example.test"),
      other = await h.signup("required-other@example.test");
    const denied = await h.request(
      "POST",
      "/api/workspaces",
      { name: "Before explicit agreement" },
      owner.cookie,
    );
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error.code, "LEGAL_ACCEPTANCE_REQUIRED");
    assert.equal(
      (await h.request("GET", "/api/me/export", undefined, owner.cookie))
        .statusCode,
      200,
    );
    assert.equal(
      (await h.request("GET", "/api/me", undefined, owner.cookie)).json()
        .legalConsent.required,
      true,
    );
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/me/legal-consent",
          acceptance(information),
          owner.cookie,
        )
      ).statusCode,
      200,
    );
    const workspace = await h.workspace(owner.cookie);
    assert.equal(
      (
        await h.request("GET", "/api/me/legal-consent", undefined, other.cookie)
      ).json().accepted,
      false,
    );
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/workspaces",
          { name: "Another account" },
          other.cookie,
        )
      ).json().error.code,
      "LEGAL_ACCEPTANCE_REQUIRED",
    );
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/me/legal-consent",
          acceptance(information),
          other.cookie,
        )
      ).statusCode,
      200,
    );
    const foreign = await h.request(
      "POST",
      "/api/workspaces/" + workspace.id + "/rooms",
      { title: "Cannot use another workspace" },
      other.cookie,
    );
    assert.ok([403, 404].includes(foreign.statusCode), foreign.body);
  },
);

test(
  "a changed published body requires a fresh action even if its human version label was reused",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, information } = await fixture(t, true);
    const user = await h.signup("consent-upgrade@example.test");
    const first = await h.request(
      "POST",
      "/api/me/legal-consent",
      acceptance(information),
      user.cookie,
    );
    assert.equal(first.statusCode, 200, first.body);
    const updated = await edition(
      t,
      "synthetic-v1",
      "A changed synthetic document with the same label.",
    );
    const next = {
      ...h.c,
      publicInformation: { ...updated.information, acceptanceRequired: true },
    };
    await h.app.close();
    const app = await createApp(next, {
      pool: h.pool,
      media: h.media,
      logger: false,
    });
    try {
      const request = (method: "GET" | "POST", url: string, body?: unknown) =>
        app.inject({
          method,
          url,
          headers: { origin: next.appUrl, cookie: user.cookie },
          ...(body === undefined
            ? {}
            : { payload: body as Record<string, unknown> }),
        });
      const status = await request("GET", "/api/me/legal-consent");
      assert.equal(status.json().accepted, false);
      assert.notEqual(
        status.json().current.manifestSha256,
        first.json().receipt.manifestSha256,
      );
      const stale = await request(
        "POST",
        "/api/me/legal-consent",
        acceptance(information),
      );
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(
        (await request("POST", "/api/workspaces", { name: "Still blocked" }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_legal_acceptances",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await request(
            "POST",
            "/api/me/legal-consent",
            acceptance(updated.information),
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_legal_acceptances",
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (await h.pool.query("SELECT count(*)::int AS n FROM im_legal_versions"))
          .rows[0].n,
        2,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT accepted_at FROM im_legal_acceptances WHERE id=$1",
            [first.json().receipt.id],
          )
        ).rows[0].accepted_at.toISOString(),
        first.json().receipt.acceptedAt,
      );
    } finally {
      await app.close();
    }
  },
);

test(
  "personal export includes only one's immutable receipts and deletion does not require new agreement",
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const { h, information } = await fixture(t, true);
    const first = await h.signup("consent-export@example.test"),
      second = await h.signup("consent-private@example.test");
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/me/legal-consent",
          acceptance(information),
          first.cookie,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await h.request(
          "POST",
          "/api/me/legal-consent",
          acceptance(information),
          second.cookie,
        )
      ).statusCode,
      200,
    );
    const exported = await h.request(
      "GET",
      "/api/me/export",
      undefined,
      first.cookie,
    );
    assert.equal(exported.statusCode, 200, exported.body);
    assert.equal(exported.json().legalAcceptances.length, 1);
    assert.equal(
      exported.json().legalAcceptances[0].manifest_sha256,
      information.manifestSha256,
    );
    assert.equal(
      exported.json().legalAcceptances[0].documents.terms.title,
      "Synthetic document",
    );
    assert.equal(exported.body.includes(second.id), false);
    const neverAccepted = await h.signup("consent-decline-delete@example.test");
    const deleted = await h.request(
      "DELETE",
      "/api/me",
      { password, confirmation: "DELETE" },
      neverAccepted.cookie,
    );
    assert.equal(deleted.statusCode, 200, deleted.body);
    const removed = await h.request(
      "DELETE",
      "/api/me",
      { password, confirmation: "DELETE" },
      first.cookie,
    );
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(
      (
        await h.pool.query(
          "SELECT 1 FROM im_legal_acceptances WHERE user_id=$1",
          [first.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await h.pool.query(
          "SELECT 1 FROM im_legal_acceptances WHERE user_id=$1",
          [second.id],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await h.pool.query("SELECT count(*)::int AS n FROM im_legal_versions"))
        .rows[0].n,
      1,
      "public snapshots contain no personal data and remain usable by other receipts",
    );
  },
);
