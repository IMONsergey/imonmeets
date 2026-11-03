import { createHash } from "node:crypto";
export const fixtureManifestHash = "a".repeat(64);
export function verifiedAnalysisFixture() {
  const files = ["config.json", "model.bin", "tokenizer.json"].map((path) => ({
    bytes: 7,
    path,
    sha256: "b".repeat(64),
  }));
  const sha256 = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return {
    text: "Synthetic provenance",
    segments: [{ start: 0, end: 1, text: "Synthetic provenance" }],
    language: "en",
    duration: 2,
    model: "faster-whisper-sha256-" + sha256,
    provenance: {
      schema: 1,
      manifestSha256: fixtureManifestHash,
      whisper: { sha256, files },
    },
  };
}
