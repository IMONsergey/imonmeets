import path from "node:path";

export const PREPARE_TURN_SHA256 = "73978cd7c6c94ba3a0b3e7b977f71e11a87afd692e02e905f8fd6f3d2584921d";
export const ACME_MAIN_PORT = 18080;
export function required(ok, code) {
  if (!ok) throw Object.assign(new Error(code), { code });
}
export function absolutePath(value) {
  required(typeof value === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value) &&
    value !== "/" && !value.endsWith("/") && path.normalize(value) === value &&
    !value.split("/").some((p) => p === "." || p === ".."), "INVALID_ABSOLUTE_PATH");
  return value;
}
export function certificateName(value) {
  required(typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value), "INVALID_CERTIFICATE_NAME");
  return value;
}
export function runtimeContext(value, role) {
  required(value && typeof value === "object" && !Array.isArray(value), "INVALID_RUNTIME_CONTEXT");
  const expected = role === "main"
    ? ["node", "codeDirectory", "projectDirectory", "projectName", "envFile", "composeFiles", "turnDirectory"]
    : ["node", "codeDirectory"];
  required(Object.keys(value).sort().join() === expected.sort().join(), "INVALID_RUNTIME_CONTEXT");
  absolutePath(value.node); absolutePath(value.codeDirectory);
  if (role === "main") {
    for (const key of ["projectDirectory", "envFile", "turnDirectory"]) absolutePath(value[key]);
    required(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value.projectName || ""), "INVALID_COMPOSE_PROJECT");
    required(Array.isArray(value.composeFiles) && value.composeFiles.length >= 1 && value.composeFiles.length <= 8 &&
      new Set(value.composeFiles).size === value.composeFiles.length, "INVALID_COMPOSE_FILES");
    value.composeFiles.forEach(absolutePath);
    required(value.turnDirectory.startsWith(value.projectDirectory + "/"), "TURN_DIRECTORY_OUTSIDE_PROJECT");
  }
  return structuredClone(value);
}
export function renewalConfig(role, name, domains, context) {
  required(["main", "witness"].includes(role), "INVALID_ROLE");
  certificateName(name);
  required(Array.isArray(domains) && domains.length === new Set(domains).size &&
    domains.length >= 1 && domains.length <= 4 && domains.every((v) =>
      typeof v === "string" && v.length <= 253 && v.split(".").length >= 2 &&
      v.split(".").every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))), "INVALID_CERTIFICATE_DOMAINS");
  required(role !== "witness" || domains.length === 1, "INVALID_CERTIFICATE_DOMAINS");
  return {
    schema: 1, role, certificateName: name, domains,
    lineage: `/etc/imonmeets/acme/${role}/live/${name}`,
    store: `/etc/imonmeets/tls/${role}`,
    runtime: runtimeContext(context, role),
    prepareTurnSha256: role === "main" ? PREPARE_TURN_SHA256 : null,
  };
}
export function validateRenewalConfig(value) {
  const expected = renewalConfig(value?.role, value?.certificateName, value?.domains, value?.runtime);
  required(JSON.stringify(value) === JSON.stringify(expected), "INVALID_RENEWAL_CONFIG");
  return expected;
}
