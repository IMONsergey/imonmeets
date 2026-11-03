import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export type PublicDocument = {
  title: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
};
type Documents = {
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
  return { supportEmail, supportHours, documents, manifestSha256 };
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
