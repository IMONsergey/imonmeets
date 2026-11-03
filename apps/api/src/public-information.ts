import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export type PublicDocument = {
  title: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
};
export type Documents = {
  schema: 1;
  version: string;
  publishedAt: string;
  operator: { name: string; registration: string; address: string };
  privacy: PublicDocument;
  terms: PublicDocument;
};

function email(value = ""): string {
  if (
    value &&
    (value.length > 254 ||
      !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
        value,
      ))
  ) {
    throw new Error("SUPPORT_EMAIL must be a plain email address");
  }
  return value;
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  );
}
function document(value: unknown): value is PublicDocument {
  if (!value || typeof value !== "object") return false;
  const d = value as PublicDocument;
  return (
    text(d.title, 200) &&
    Array.isArray(d.sections) &&
    d.sections.length > 0 &&
    d.sections.length <= 40 &&
    d.sections.every(
      (section) =>
        section &&
        text(section.heading, 200) &&
        Array.isArray(section.paragraphs) &&
        section.paragraphs.length > 0 &&
        section.paragraphs.length <= 30 &&
        section.paragraphs.every((p) => text(p, 6000)),
    )
  );
}

export function loadPublicInformation(env: NodeJS.ProcessEnv) {
  if (
    env.LEGAL_ACCEPTANCE_REQUIRED &&
    !["true", "false"].includes(env.LEGAL_ACCEPTANCE_REQUIRED)
  )
    throw new Error("LEGAL_ACCEPTANCE_REQUIRED must be true or false");
  const acceptanceRequired = env.LEGAL_ACCEPTANCE_REQUIRED === "true";
  const supportEmail = email(env.SUPPORT_EMAIL?.trim());
  const supportHours = env.SUPPORT_HOURS?.trim() || "";
  if (supportHours && !text(supportHours, 200))
    throw new Error("Invalid SUPPORT_HOURS");
  if (
    env.PUBLIC_LEGAL_APPROVED &&
    !["true", "false"].includes(env.PUBLIC_LEGAL_APPROVED)
  )
    throw new Error("PUBLIC_LEGAL_APPROVED must be true or false");
  let documents: Documents | null = null;
  let manifestSha256: string | null = null;
  if (env.PUBLIC_LEGAL_APPROVED === "true") {
    if (
      !supportEmail ||
      !env.PUBLIC_LEGAL_MANIFEST_PATH ||
      !/^[a-f0-9]{64}$/.test(env.PUBLIC_LEGAL_MANIFEST_SHA256 || "")
    ) {
      throw new Error(
        "Approved public documents require a support address, a manifest and its exact sha256",
      );
    }
    try {
      const info = statSync(env.PUBLIC_LEGAL_MANIFEST_PATH);
      if (!info.isFile() || info.size > 128 * 1024) throw new Error();
      const raw = readFileSync(env.PUBLIC_LEGAL_MANIFEST_PATH);
      manifestSha256 = createHash("sha256").update(raw).digest("hex");
      if (manifestSha256 !== env.PUBLIC_LEGAL_MANIFEST_SHA256)
        throw new Error();
      const d = JSON.parse(raw.toString("utf8")) as Documents;
      if (
        d.schema !== 1 ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(d.version) ||
        !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(d.publishedAt) ||
        !Number.isFinite(Date.parse(d.publishedAt)) ||
        Date.parse(d.publishedAt) > Date.now() ||
        !d.operator ||
        !text(d.operator.name, 300) ||
        !text(d.operator.registration, 500) ||
        !text(d.operator.address, 1000) ||
        !document(d.privacy) ||
        !document(d.terms)
      )
        throw new Error();
      const clean = (value: PublicDocument): PublicDocument => ({
        title: value.title,
        sections: value.sections.map((section) => ({
          heading: section.heading,
          paragraphs: [...section.paragraphs],
        })),
      });
      documents = {
        schema: 1,
        version: d.version,
        publishedAt: d.publishedAt,
        operator: {
          name: d.operator.name,
          registration: d.operator.registration,
          address: d.operator.address,
        },
        privacy: clean(d.privacy),
        terms: clean(d.terms),
      };
    } catch {
      // Configuration errors must not echo a filesystem path or document body.
      throw new Error(
        "Public legal manifest is unavailable, changed or invalid",
      );
    }
  }
  if (acceptanceRequired && !documents)
    throw new Error(
      "Required legal acceptance needs approved published documents",
    );
  return {
    supportEmail,
    supportHours,
    documents,
    manifestSha256,
    acceptanceRequired,
  };
}

/** Canonical UTF-8 JSON of the exact plain-text content returned for publication. */
export function canonicalPublicJson(value: unknown): string {
  if (value === null) return "null";
  if (["string", "boolean"].includes(typeof value))
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object")
    throw new Error("Invalid public document value");
  if (Array.isArray(value))
    return "[" + value.map(canonicalPublicJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (key) =>
          JSON.stringify(key) +
          ":" +
          canonicalPublicJson((value as Record<string, unknown>)[key]),
      )
      .join(",") +
    "}"
  );
}

export function publishedDocument(
  value: ReturnType<typeof loadPublicInformation>,
  kind: "terms" | "privacy",
) {
  const documents = value.documents;
  if (!documents || !value.manifestSha256) return null;
  const content = {
    kind,
    version: documents.version,
    publishedAt: documents.publishedAt,
    operator: documents.operator,
    document: documents[kind],
  };
  return {
    ...content,
    manifestSha256: value.manifestSha256,
    documentSha256: createHash("sha256")
      .update(canonicalPublicJson(content), "utf8")
      .digest("hex"),
  };
}

export function legalEdition(value: ReturnType<typeof loadPublicInformation>) {
  const terms = publishedDocument(value, "terms"),
    privacy = publishedDocument(value, "privacy");
  if (!terms || !privacy) return null;
  return {
    version: terms.version,
    publishedAt: terms.publishedAt,
    manifestSha256: terms.manifestSha256,
    termsSha256: terms.documentSha256,
    privacySha256: privacy.documentSha256,
  };
}

export function publicInformationSummary(
  value: ReturnType<typeof loadPublicInformation>,
) {
  return {
    supportEmail: value.supportEmail || null,
    supportHours: value.supportHours || null,
    legalVersion: value.documents?.version || null,
    legalPublishedAt: value.documents?.publishedAt || null,
    legalManifestSha256: value.manifestSha256,
    legalAcceptanceRequired: value.acceptanceRequired,
    operatorName: value.documents?.operator.name || null,
  };
}

export function isApplicationPage(pathname: string): boolean {
  return (
    [
      "/",
      "/about",
      "/help",
      "/privacy",
      "/terms",
      "/rooms",
      "/recordings",
      "/team",
      "/settings",
      "/consent",
      "/login",
      "/register",
      "/forgot-password",
      "/reset-password",
      "/set-password",
      "/verify-email",
      "/invite",
    ].includes(pathname) || /^\/join\/[A-Za-z0-9_-]{16,128}\/?$/.test(pathname)
  );
}
