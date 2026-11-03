import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import type { Pool, QueryResultRow } from "pg";
import { z } from "zod";
import type { createAuth } from "./auth.js";
import type { Config } from "./config.js";
import { transaction } from "./db.js";
import { assert } from "./policy.js";
import { requireBudget, type RateLimiter } from "./limits.js";
import { canonicalPublicJson, legalEdition } from "./public-information.js";

const selectEvidence =
  "SELECT a.id,a.accepted_at,a.evidence_schema,a.terms_accepted,a.privacy_acknowledged,v.manifest_sha256,v.version,v.published_at,v.terms_sha256,v.privacy_sha256 FROM im_legal_acceptances a JOIN im_legal_versions v USING(manifest_sha256) WHERE a.user_id=$1 AND a.manifest_sha256=$2";
function receipt(row: QueryResultRow) {
  return {
    id: row.id as string,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    evidenceSchema: row.evidence_schema as "explicit-account-v1",
    version: row.version as string,
    publishedAt: new Date(row.published_at).toISOString(),
    manifestSha256: row.manifest_sha256 as string,
    termsSha256: row.terms_sha256 as string,
    privacySha256: row.privacy_sha256 as string,
    termsAccepted: row.terms_accepted as true,
    privacyAcknowledged: row.privacy_acknowledged as true,
  };
}
export async function legalConsentStatus(
  pool: Pool,
  c: Config,
  userId: string,
) {
  const current = legalEdition(c.publicInformation);
  const row = current
    ? (await pool.query(selectEvidence, [userId, current.manifestSha256]))
        .rows[0]
    : undefined;
  return {
    required: c.publicInformation.acceptanceRequired,
    current,
    accepted: Boolean(row),
    receipt: row ? receipt(row) : null,
  };
}

/** Read access and leaving/deleting data remain available after declining a new edition. */
export function legalAcceptanceNeeded(
  method: string,
  pathname: string,
): boolean {
  if (["GET", "HEAD", "OPTIONS", "DELETE"].includes(method)) return false;
  if (
    ["/api/me/legal-consent", "/api/sessions/revoke-others"].includes(pathname)
  )
    return false;
  if (/^\/api\/workspaces\/[^/]+\/transfer-ownership$/.test(pathname))
    return false;
  if (/^\/api\/workspaces\/[^/]+\/rooms\/[^/]+\/close$/.test(pathname))
    return false;
  if (/^\/api\/workspaces\/[^/]+\/recordings\/[^/]+\/stop$/.test(pathname))
    return false;
  return true;
}

export async function requireLegalAcceptance(
  pool: Pool,
  c: Config,
  userId: string,
  req: FastifyRequest,
) {
  if (
    !c.publicInformation.acceptanceRequired ||
    !legalAcceptanceNeeded(req.method, req.url.split("?")[0]!)
  )
    return;
  assert(
    (await legalConsentStatus(pool, c, userId)).accepted,
    403,
    "LEGAL_ACCEPTANCE_REQUIRED",
    "Откройте актуальные документы и подтвердите свой выбор перед продолжением.",
  );
}

export function registerLegalConsent(
  app: FastifyInstance,
  deps: {
    c: Config;
    pool: Pool;
    auth: ReturnType<typeof createAuth>;
    limiter: RateLimiter;
  },
) {
  const { c, pool, auth, limiter } = deps;
  async function verifiedSession(req: FastifyRequest) {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    assert(session, 401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    assert(
      session.user.emailVerified,
      403,
      "EMAIL_UNVERIFIED",
      "Сначала подтвердите адрес почты.",
    );
    return session;
  }
  app.get("/api/me/legal-consent", async (req) => {
    const session = await verifiedSession(req);
    return {
      ...(await legalConsentStatus(pool, c, session.user.id)),
      documents: c.publicInformation.documents,
    };
  });
  app.post("/api/me/legal-consent", async (req) => {
    const session = await verifiedSession(req);
    const body = z
      .object({
        version: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        termsSha256: z.string().regex(/^[a-f0-9]{64}$/),
        privacySha256: z.string().regex(/^[a-f0-9]{64}$/),
        termsAccepted: z.literal(true),
        privacyAcknowledged: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const current = legalEdition(c.publicInformation);
    assert(
      current && c.publicInformation.documents,
      409,
      "LEGAL_DOCUMENTS_UNAVAILABLE",
      "Утверждённые документы ещё не опубликованы.",
    );
    assert(
      body.version === current.version &&
        body.manifestSha256 === current.manifestSha256 &&
        body.termsSha256 === current.termsSha256 &&
        body.privacySha256 === current.privacySha256,
      409,
      "LEGAL_VERSION_CHANGED",
      "Документы обновились. Прочитайте текущую версию и подтвердите выбор заново.",
    );
    await requireBudget(limiter, `legal-acceptance:${session.user.id}`, 20, 60);
    const evidence = await transaction(pool, async (db) => {
      // Bind the explicit action to a still-active, verified account session.
      const active = await db.query(
        'SELECT s.id FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND u."emailVerified"=true FOR SHARE OF s,u',
        [session.session.id, session.user.id],
      );
      assert(
        active.rowCount,
        401,
        "UNAUTHENTICATED",
        "Сеанс завершён. Войдите в аккаунт.",
      );
      await db.query(
        "INSERT INTO im_legal_versions(manifest_sha256,version,published_at,terms_sha256,privacy_sha256,documents) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(manifest_sha256) DO NOTHING",
        [
          current.manifestSha256,
          current.version,
          current.publishedAt,
          current.termsSha256,
          current.privacySha256,
          JSON.stringify(c.publicInformation.documents),
        ],
      );
      const stored = (
        await db.query(
          "SELECT * FROM im_legal_versions WHERE manifest_sha256=$1",
          [current.manifestSha256],
        )
      ).rows[0];
      assert(
        stored &&
          stored.version === current.version &&
          stored.terms_sha256 === current.termsSha256 &&
          stored.privacy_sha256 === current.privacySha256 &&
          new Date(stored.published_at).getTime() ===
            Date.parse(current.publishedAt) &&
          canonicalPublicJson(stored.documents) ===
            canonicalPublicJson(c.publicInformation.documents),
        503,
        "LEGAL_EVIDENCE_UNAVAILABLE",
        "Не удалось проверить опубликованную версию. Повторите позже.",
      );
      await db.query(
        "INSERT INTO im_legal_acceptances(id,user_id,manifest_sha256,terms_accepted,privacy_acknowledged) VALUES($1,$2,$3,true,true) ON CONFLICT(user_id,manifest_sha256) DO NOTHING",
        [randomUUID(), session.user.id, current.manifestSha256],
      );
      return receipt(
        (
          await db.query(selectEvidence, [
            session.user.id,
            current.manifestSha256,
          ])
        ).rows[0]!,
      );
    });
    return { accepted: true, receipt: evidence };
  });
}
