import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { fromNodeHeaders } from "better-auth/node";
import { z } from "zod";
import type { createAuth } from "./auth.js";
import type { Config } from "./config.js";
import { transaction } from "./db.js";
import { requireBudget, type RateLimiter } from "./limits.js";
import { assert } from "./policy.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: {
    c: Config;
    pool: Pool;
    auth: ReturnType<typeof createAuth>;
    limiter: RateLimiter;
    sendMail: (to: string, subject: string, text: string) => Promise<void>;
  },
) {
  const { c, pool, auth, limiter, sendMail } = deps;
  async function verifiedSession(req: FastifyRequest) {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    assert(session, 401, "AUTH_REQUIRED", "Войдите в аккаунт.");
    assert(
      session.user.emailVerified,
      403,
      "EMAIL_UNVERIFIED",
      "Сначала подтвердите адрес почты.",
    );
    return session;
  }
  async function hasPassword(userId: string) {
    return Boolean(
      (
        await pool.query(
          'SELECT 1 FROM "account" WHERE "userId"=$1 AND "providerId"=\'credential\' AND password IS NOT NULL',
          [userId],
        )
      ).rowCount,
    );
  }
  app.get("/api/me/security", async (req) => {
    const session = await verifiedSession(req);
    return {
      hasPassword: await hasPassword(session.user.id),
      addPasswordAvailable: c.emailConfigured,
      twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
    };
  });
  app.post("/api/me/password/request", async (req) => {
    const session = await verifiedSession(req);
    assert(
      c.emailConfigured,
      503,
      "EMAIL_UNAVAILABLE",
      "Отправка писем временно недоступна. Обратитесь к администратору.",
    );
    assert(
      !(await hasPassword(session.user.id)),
      409,
      "PASSWORD_ALREADY_SET",
      "Пароль уже задан. Используйте обычную смену или восстановление пароля.",
    );
    const token = randomBytes(32).toString("base64url");
    await transaction(pool, async (db) => {
      await requireBudget(
        limiter,
        `password-enrollment:${session.user.id}`,
        3,
        3600,
        db,
      );
      // Serialize replacing the user's previous proof, so only the latest link
      // exists. It remains bound to the precise initiating session and email.
      await db.query('SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE', [
        session.user.id,
      ]);
      await db.query("DELETE FROM im_password_enrollments WHERE user_id=$1", [
        session.user.id,
      ]);
      await db.query(
        "INSERT INTO im_password_enrollments(token_hash,user_id,session_id,email_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '15 minutes')",
        [
          hash(token),
          session.user.id,
          session.session.id,
          hash(session.user.email.toLowerCase()),
        ],
      );
      await db.query(
        "INSERT INTO im_audit(actor_id,event) VALUES($1,'identity.password_enrollment_requested')",
        [session.user.id],
      );
    });
    const url = new URL("/set-password", c.appUrl);
    url.hash = new URLSearchParams({ token }).toString();
    await sendMail(
      session.user.email,
      "Добавление пароля IMON Meets",
      `Вы запросили добавление пароля к аккаунту IMON Meets. Откройте ссылку в том же браузере, где сейчас выполнен вход. Она действует 15 минут: ${url}\n\nЕсли вы не запрашивали добавление пароля, не открывайте ссылку. Вход через Google и включенная двухфакторная защита сохранятся.`,
    );
    return { requested: true };
  });
  app.post("/api/me/password/complete", async (req) => {
    const session = await verifiedSession(req);
    const b = z
      .object({
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        newPassword: z.string().min(10).max(128),
      })
      .strict()
      .parse(req.body);
    await requireBudget(
      limiter,
      `password-enrollment-complete:${session.user.id}`,
      6,
      900,
    );
    // Consume once before invoking Better Auth's server-only credential API.
    // A failed or interrupted completion requires a new email proof; it never
    // turns a used link into a reusable capability.
    const proof = await pool.query(
      'DELETE FROM im_password_enrollments p USING "user" u,"session" s ' +
        "WHERE p.token_hash=$1 AND p.user_id=$2 AND p.session_id=$3 AND p.email_hash=$4 " +
        'AND p.expires_at>now() AND u.id=p.user_id AND u."emailVerified"=true AND lower(u.email)=$5 ' +
        'AND s.id=p.session_id AND s."userId"=u.id AND s."expiresAt">now() RETURNING p.user_id',
      [
        hash(b.token),
        session.user.id,
        session.session.id,
        hash(session.user.email.toLowerCase()),
        session.user.email.toLowerCase(),
      ],
    );
    assert(
      proof.rowCount === 1,
      403,
      "PASSWORD_PROOF_INVALID",
      "Ссылка истекла или открыта в другом сеансе. Запросите новую ссылку в настройках безопасности.",
    );
    await auth.api.setPassword({
      headers: fromNodeHeaders(req.headers),
      body: { newPassword: b.newPassword },
    });
    await transaction(pool, async (db) => {
      await db.query('DELETE FROM "session" WHERE "userId"=$1', [
        session.user.id,
      ]);
      await db.query("DELETE FROM im_password_enrollments WHERE user_id=$1", [
        session.user.id,
      ]);
      await db.query(
        "DELETE FROM \"verification\" WHERE value=$1 AND (identifier LIKE '2fa-%' OR identifier LIKE 'trust-device-%')",
        [session.user.id],
      );
      await db.query(
        "INSERT INTO im_audit(actor_id,event) VALUES($1,'identity.password_added_sessions_revoked')",
        [session.user.id],
      );
    });
    return { status: true, reauthenticationRequired: true };
  });
}
