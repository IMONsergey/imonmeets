import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Preserve the accepted historical monolithic generator override. For the
// shared renderer, record its real relative dependency as well as the entrypoint.
// This is a manifest for these two supported layouts, not a general JS resolver.
export function ingressSourceEvidence(generator) {
  const source = readFileSync(generator);
  const shared = /\bfrom\s+["']\.\/ingress-nginx-tls\.mjs["']/.test(source.toString("utf8"));
  const dependencies = shared
    ? { "ingress-nginx-tls.mjs": sha(readFileSync(path.join(path.dirname(generator), "ingress-nginx-tls.mjs"))) }
    : {};
  return {
    generatorSha256: sha(source),
    generatorLayout: shared ? "shared-tls-renderer" : "legacy-monolithic",
    generatorDependenciesSha256: dependencies,
  };
}
