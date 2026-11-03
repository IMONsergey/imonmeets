import test from "node:test";
import assert from "node:assert/strict";
import {
  fixtureManifestHash,
  verifiedAnalysisFixture,
} from "./analysis-fixtures.js";
import {
  analysisResultSchema,
  verifyAnalysisProvenance,
} from "../src/analysis.js";

test("new analysis results require the approved manifest and measured inventory identity", () => {
  const value = verifiedAnalysisFixture();
  assert.deepEqual(
    verifyAnalysisProvenance(value, fixtureManifestHash, false),
    value,
  );
  const legacy = { ...value, provenance: undefined };
  assert.equal(
    analysisResultSchema.safeParse(legacy).success,
    true,
    "historical results remain readable",
  );
  for (const changed of [
    legacy,
    { ...value, model: "claimed-model-name" },
    {
      ...value,
      provenance: { ...value.provenance, manifestSha256: "f".repeat(64) },
    },
    {
      ...value,
      provenance: {
        ...value.provenance,
        whisper: { ...value.provenance.whisper, sha256: "0".repeat(64) },
      },
    },
    {
      ...value,
      provenance: {
        ...value.provenance,
        whisper: {
          ...value.provenance.whisper,
          files: value.provenance.whisper.files.slice(1),
        },
      },
    },
    {
      ...value,
      provenance: {
        ...value.provenance,
        whisper: {
          ...value.provenance.whisper,
          files: [
            ...value.provenance.whisper.files,
            value.provenance.whisper.files[0],
          ],
        },
      },
    },
  ])
    assert.throws(() =>
      verifyAnalysisProvenance(changed, fixtureManifestHash, false),
    );
  assert.throws(() => verifyAnalysisProvenance(value, "", false));
  assert.throws(() => verifyAnalysisProvenance(value, "c".repeat(64), false));
});
test("summary identity must match the measured artifact and requested processing", () => {
  const base = verifiedAnalysisFixture();
  assert.throws(() =>
    verifyAnalysisProvenance(base, fixtureManifestHash, true),
  );
  const withSummary = {
    ...base,
    summary: "Synthetic note",
    summaryModel: "gguf-sha256-" + "d".repeat(64),
    provenance: {
      ...base.provenance,
      summary: { sha256: "d".repeat(64), bytes: 32 },
    },
  };
  assert.deepEqual(
    verifyAnalysisProvenance(withSummary, fixtureManifestHash, true),
    withSummary,
  );
  assert.throws(() =>
    verifyAnalysisProvenance(withSummary, fixtureManifestHash, false),
  );
  assert.throws(() =>
    verifyAnalysisProvenance(
      { ...withSummary, summaryModel: "wrong" },
      fixtureManifestHash,
      true,
    ),
  );
  assert.throws(() =>
    verifyAnalysisProvenance(
      { ...withSummary, summary: "" },
      fixtureManifestHash,
      true,
    ),
  );
  const silent = {
    ...base,
    text: "",
    segments: [],
    summary: "No speech recognized",
  };
  assert.doesNotThrow(() =>
    verifyAnalysisProvenance(silent, fixtureManifestHash, true),
  );
});
