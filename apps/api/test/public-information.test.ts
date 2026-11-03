import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isApplicationPage,
  loadPublicInformation,
  publicInformationSummary,
} from "../src/public-information.js";

test("unapproved legal drafts are never loaded or published", () => {
  const result = loadPublicInformation({
    PUBLIC_LEGAL_MANIFEST_PATH: "/nonexistent/private-document",
    SUPPORT_EMAIL: "support@example.test",
  });
  assert.equal(result.documents, null);
  assert.equal(publicInformationSummary(result).legalVersion, null);
  assert.throws(() =>
    loadPublicInformation({
      SUPPORT_EMAIL: "a@example.test\r\nBcc: b@example.test",
    }),
  );
  assert.throws(() => loadPublicInformation({ PUBLIC_LEGAL_APPROVED: "yes" }));
  assert.throws(() => loadPublicInformation({ PUBLIC_LEGAL_APPROVED: "true" }));
});

test("published documents bind reviewed bytes, identity and version; HTML remains plain text", () => {
  const folder = mkdtempSync(join(tmpdir(), "imon-public-docs-"));
  try {
    const file = join(folder, "manifest.json");
    const document = {
      title: "Document",
      sections: [
        { heading: "Terms", paragraphs: ["<script>alert('text')</script>"] },
      ],
    };
    const data = {
      schema: 1,
      version: "2026-11-03.1",
      publishedAt: "2026-01-01T00:00:00Z",
      operator: {
        name: "Synthetic test operator",
        registration: "test only",
        address: "test only",
      },
      privacy: document,
      terms: document,
    };
    const raw = JSON.stringify(data);
    writeFileSync(file, raw);
    const env = {
      SUPPORT_EMAIL: "support@example.test",
      PUBLIC_LEGAL_APPROVED: "true",
      PUBLIC_LEGAL_MANIFEST_PATH: file,
      PUBLIC_LEGAL_MANIFEST_SHA256: createHash("sha256")
        .update(raw)
        .digest("hex"),
    };
    const result = loadPublicInformation(env);
    assert.equal(
      result.documents?.privacy.sections[0]?.paragraphs[0],
      "<script>alert('text')</script>",
    );
    assert.equal(
      publicInformationSummary(result).legalManifestSha256,
      env.PUBLIC_LEGAL_MANIFEST_SHA256,
    );
    assert.equal("documents" in publicInformationSummary(result), false);
    writeFileSync(file, raw + " ");
    assert.throws(() => loadPublicInformation(env), /changed or invalid/);
    writeFileSync(
      file,
      JSON.stringify({ ...data, operator: { name: "missing-fields" } }),
    );
    assert.throws(
      () =>
        loadPublicInformation({
          ...env,
          PUBLIC_LEGAL_MANIFEST_SHA256: createHash("sha256")
            .update(
              JSON.stringify({ ...data, operator: { name: "missing-fields" } }),
            )
            .digest("hex"),
        }),
      /invalid/,
    );
  } finally {
    rmSync(folder, { recursive: true });
  }
});

test("frontend routes have a bounded allowlist and unknown documents get HTTP404", () => {
  for (const path of [
    "/",
    "/privacy",
    "/terms",
    "/help",
    "/about",
    "/login",
    "/set-password",
    "/rooms",
    "/join/room_12345678901234567890",
  ])
    assert.equal(isApplicationPage(path), true, path);
  for (const path of [
    "/unknown",
    "/api/nope",
    "/join/short",
    "/join/../../settings",
    "/settings/missing",
    "/file.js",
  ])
    assert.equal(isApplicationPage(path), false, path);
});
