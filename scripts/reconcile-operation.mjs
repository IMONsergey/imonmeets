#!/usr/bin/env node
// Existing-owner-session tool. Provider credentials never leave the API.
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (key === "--apply") {
    if (args.has(key)) throw new Error("Duplicate --apply");
    args.set(key, true);
    continue;
  }
  if (
    ![
      "--origin",
      "--workspace",
      "--kind",
      "--local-id",
      "--provider-id",
      "--version",
      "--preview-audit-id",
    ].includes(key) ||
    !process.argv[i + 1] ||
    args.has(key)
  )
    throw new Error("Invalid or duplicate argument: " + key);
  args.set(key, process.argv[++i]);
}
const origin = new URL(String(args.get("--origin") ?? ""));
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.port ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Use the canonical HTTPS origin without a port or path.");
const kind = args.get("--kind");
if (kind !== "payment" && kind !== "recording")
  throw new Error("--kind must be payment or recording.");
const workspace = args.get("--workspace"),
  localId = args.get("--local-id"),
  providerId = args.get("--provider-id");
if (
  ![workspace, localId, providerId].every(
    (value) =>
      typeof value === "string" && value.length > 0 && value.length <= 128,
  )
)
  throw new Error("--workspace, --local-id and --provider-id are required.");
const cookie = process.env.IMON_OWNER_COOKIE;
if (!cookie || /[\r\n]/.test(cookie))
  throw new Error(
    "Set IMON_OWNER_COOKIE through a protected environment; do not pass a cookie on the command line.",
  );
const apply = args.get("--apply") === true;
if (apply && (!args.get("--version") || !args.get("--preview-audit-id")))
  throw new Error(
    "Apply requires the reviewed --version and --preview-audit-id.",
  );
const response = await fetch(
  origin.origin +
    "/api/workspaces/" +
    encodeURIComponent(workspace) +
    "/" +
    kind +
    "s/" +
    encodeURIComponent(localId) +
    "/reconcile",
  {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
    headers: {
      Origin: origin.origin,
      Cookie: cookie,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      [kind === "payment" ? "providerPaymentId" : "egressId"]: providerId,
      apply,
      ...(apply
        ? {
            version: args.get("--version"),
            previewAuditId: args.get("--preview-audit-id"),
          }
        : {}),
    }),
  },
);
const raw = await response.text();
let result;
try {
  result = JSON.parse(raw);
} catch {
  throw new Error(
    "API returned a non-JSON response, status " + response.status,
  );
}
if (!response.ok) {
  console.error(
    JSON.stringify({
      status: response.status,
      code: result?.error?.code ?? "UNKNOWN",
      message: result?.error?.message ?? "Reconciliation refused",
    }),
  );
  process.exitCode = 1;
} else console.log(JSON.stringify(result, null, 2));
