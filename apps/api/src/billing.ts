import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction } from "./db.js";
import { assert, ApiError } from "./policy.js";
import { requireBudget } from "./limits.js";
import {
  createYookassaClient,
  paymentMatchesOrder,
  type ProviderPayment,
} from "./payments.js";
import type { SuiteDependencies } from "./suite.js";

type Row = QueryResultRow;
export { billingSchema } from "./billing-schema.js";
const paymentJson = (r: Row) => ({
  id: r.id,
  status: r.status,
  amountKopecks: Number(r.amount_kopecks),
  currency: r.currency,
  test: r.test,
  createdAt: r.created_at,
  confirmationUrl: r.confirmation_url,
  appliedAt: r.applied_at,
});
export async function workspaceLimits(
  db: Pool | PoolClient,
  c: Config,
  workspaceId: string,
) {
  const row = (
    await db.query(
      "SELECT plan_id,paid_until FROM im_workspace_plans WHERE workspace_id=$1",
      [workspaceId],
    )
  ).rows[0];
  if (row?.plan_id === "pro" && new Date(row.paid_until).getTime() > Date.now())
    return c.billing.proLimits;
  if (c.billing.commercial || row?.plan_id === "pro")
    return c.billing.freeLimits;
  return {
    rooms: c.limits.rooms,
    members: c.limits.members,
    participants: c.limits.participants,
    activeRecordings: c.limits.recordings,
  };
}
export async function registerBilling(
  app: FastifyInstance,
  d: SuiteDependencies,
) {
  const { c, pool, user, membership, lockWorkspace, audit, limiter } = d;
  const provider = c.billingConfigured
    ? createYookassaClient(
        {
          shopId: c.billing.shopId,
          secretKey: c.billing.secretKey,
          testMode: c.billing.testMode,
          appUrl: c.appUrl,
          receipt: c.billing.receipt,
        },
        d.paymentRequest,
      )
    : null;
  const params = (v: unknown) =>
    z
      .object({
        workspaceId: z.string().min(1).max(128),
        paymentId: z.uuid().optional(),
      })
      .parse(v);
  const expected = (r: Row) => ({
    paymentId: r.id,
    workspaceId: r.workspace_id,
    planId: r.plan_id,
    userId: r.user_id,
    amountKopecks: Number(r.amount_kopecks),
  });
  async function applyProvider(payment: ProviderPayment, localId: string) {
    const found = (
      await pool.query("SELECT workspace_id FROM im_payments WHERE id=$1", [
        localId,
      ])
    ).rows[0];
    assert(found, 404, "PAYMENT_NOT_FOUND", "Платеж не найден.");
    return transaction(pool, async (db) => {
      const workspaceExists = Boolean(
        (
          await db.query(
            "SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE",
            [found.workspace_id],
          )
        ).rowCount,
      );
      const row = (
        await db.query("SELECT * FROM im_payments WHERE id=$1 FOR UPDATE", [
          localId,
        ])
      ).rows[0];
      assert(
        row &&
          paymentMatchesOrder(payment, expected(row)) &&
          payment.test === row.test &&
          (!row.provider_id || row.provider_id === payment.id),
        409,
        "PAYMENT_MISMATCH",
        "Данные платежа не совпадают с заказом.",
      );
      const fullyRefunded =
          payment.refundedKopecks >= Number(row.amount_kopecks),
        succeeded =
          payment.status === "succeeded" && payment.paid && !fullyRefunded;
      // Provider status is canonical, but a stale pending response must never undo a successful local grant.
      const status =
        fullyRefunded || row.reversed_at || row.status === "refunded"
          ? "refunded"
          : row.status === "canceled"
            ? "canceled"
            : row.applied_at &&
                ["pending", "waiting_for_capture", "canceled"].includes(
                  payment.status,
                )
              ? row.status
              : payment.status;
      await db.query(
        "UPDATE im_payments SET provider_id=$2,status=$3,confirmation_url=$4,updated_at=now() WHERE id=$1",
        [row.id, payment.id, status, payment.confirmationUrl],
      );
      if (
        succeeded &&
        row.status !== "canceled" &&
        !row.applied_at &&
        !row.reversed_at
      ) {
        assert(
          workspaceExists,
          409,
          "PAYMENT_WORKSPACE_MISSING",
          "Рабочее пространство платежа недоступно. Требуется сверка.",
        );
        const ent = (
          await db.query(
            "INSERT INTO im_workspace_plans(workspace_id,plan_id,paid_until) VALUES($1,'pro',now()+interval '30 days') ON CONFLICT(workspace_id) DO UPDATE SET plan_id='pro',paid_until=GREATEST(now(),im_workspace_plans.paid_until)+interval '30 days' RETURNING paid_until",
            [row.workspace_id],
          )
        ).rows[0];
        await db.query(
          "UPDATE im_payments SET applied_at=now(),entitlement_end=$2,entitlement_start=$2::timestamptz-interval '30 days' WHERE id=$1",
          [row.id, ent.paid_until],
        );
        await audit(
          db,
          row.workspace_id,
          row.user_id,
          "payment.applied",
          row.id,
        );
      }
      if (fullyRefunded && row.applied_at && !row.reversed_at) {
        await db.query("UPDATE im_payments SET reversed_at=now() WHERE id=$1", [
          row.id,
        ]);
        // Only the unused part of this order is removed. Completed historical orders
        // cannot subtract service purchased through an independent later renewal.
        const remaining = (
          await db.query(
            "SELECT GREATEST(interval '0 seconds',entitlement_end-GREATEST(now(),entitlement_start))::text AS amount FROM im_payments WHERE id=$1",
            [row.id],
          )
        ).rows[0].amount;
        await db.query(
          "UPDATE im_workspace_plans SET paid_until=GREATEST(now(),paid_until-$2::interval) WHERE workspace_id=$1",
          [row.workspace_id, remaining],
        );
        // Keep the remaining renewal intervals contiguous so a later refund does
        // not remove an already consumed segment twice.
        await db.query(
          "UPDATE im_payments SET entitlement_start=entitlement_start-$3::interval,entitlement_end=entitlement_end-$3::interval WHERE workspace_id=$1 AND id<>$2 AND applied_at IS NOT NULL AND reversed_at IS NULL AND entitlement_start >= $4::timestamptz",
          [row.workspace_id, row.id, remaining, row.entitlement_end],
        );
        await audit(
          db,
          workspaceExists ? row.workspace_id : null,
          null,
          "payment.refunded",
          row.id,
        );
      }
      return (await db.query("SELECT * FROM im_payments WHERE id=$1", [row.id]))
        .rows[0];
    });
  }
  async function refresh(row: Row) {
    assert(
      provider,
      503,
      "BILLING_UNAVAILABLE",
      "Прием платежей пока не подключен.",
    );
    assert(
      row.provider_id ||
        Date.now() - new Date(row.created_at).getTime() < 20 * 3600 * 1000,
      503,
      "PAYMENT_REVIEW_REQUIRED",
      "Исход создания платежа неизвестен. Нужна сверка с платежным оператором; новый заказ заблокирован.",
    );
    try {
      const canonical = row.provider_id
        ? await provider.getPayment(row.provider_id)
        : await provider.createPayment({ ...expected(row), email: row.email });
      return await applyProvider(canonical, row.id);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        "PAYMENT_CHECK_PENDING",
        "Статус платежа уточняется. Повторите проверку; новый заказ создавать не нужно.",
      );
    }
  }
  app.get("/api/workspaces/:workspaceId/plan", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req.params),
      m = await membership(workspaceId, u.id);
    const row = (
        await pool.query(
          "SELECT * FROM im_workspace_plans WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0],
      limits = await workspaceLimits(pool, c, workspaceId),
      paid = Boolean(
        row?.plan_id === "pro" &&
        new Date(row.paid_until).getTime() > Date.now(),
      );
    const usage = (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM im_rooms WHERE workspace_id=$1) AS rooms,(SELECT count(*)::int FROM im_members WHERE workspace_id=$1) AS members,(SELECT COALESCE(sum(size_bytes),0)::text FROM im_recordings WHERE workspace_id=$1 AND deleted_at IS NULL) AS recording_bytes,(SELECT count(*)::int FROM im_recordings WHERE workspace_id=$1 AND status IN ('starting','active','ending')) AS active_recordings",
        [workspaceId],
      )
    ).rows[0];
    const retention = {
      recordingRetentionDays: c.recordingRetentionDays,
      chatRetentionDays: c.chatRetentionDays,
    };
    return {
      plan: {
        id: paid
          ? "pro"
          : c.billing.commercial || row?.plan_id === "pro"
            ? "free"
            : "pilot",
        name: paid
          ? "Про"
          : c.billing.commercial || row?.plan_id === "pro"
            ? "Базовый"
            : "Пилот",
        limits: { ...limits, ...retention },
      },
      usage: {
        rooms: usage.rooms,
        members: usage.members,
        recordingBytes: Number(usage.recording_bytes),
        activeRecordings: usage.active_recordings,
      },
      billingEnabled: c.billingConfigured,
      testMode: c.billing.testMode,
      paidUntil: paid ? row.paid_until : null,
      offer: c.billingConfigured
        ? {
            id: "pro",
            name: "Про",
            amountKopecks: c.billing.amountKopecks,
            currency: "RUB",
            periodDays: 30,
            limits: { ...c.billing.proLimits, ...retention },
          }
        : null,
      payments:
        m.role === "owner"
          ? (
              await pool.query(
                "SELECT * FROM im_payments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 20",
                [workspaceId],
              )
            ).rows.map(paymentJson)
          : [],
    };
  });
  app.post("/api/workspaces/:workspaceId/payments", async (req) => {
    const u = (await user(req))!,
      { workspaceId } = params(req.params),
      b = z
        .object({ planId: z.literal("pro"), requestId: z.uuid() })
        .strict()
        .parse(req.body);
    assert(
      provider,
      503,
      "BILLING_UNAVAILABLE",
      "Прием платежей пока не подключен.",
    );
    await requireBudget(limiter, `payment-create:${u.id}`, 10, 3600);
    const row = await transaction(pool, async (db) => {
      const m = await lockWorkspace(db, workspaceId, u.id);
      assert(
        m.role === "owner",
        403,
        "FORBIDDEN",
        "Только владелец может оплачивать тариф.",
      );
      const existing = (
        await db.query(
          "SELECT * FROM im_payments WHERE workspace_id=$1 AND request_id=$2",
          [workspaceId, b.requestId],
        )
      ).rows[0];
      if (existing) return { ...existing, email: u.email };
      const pending = (
        await db.query(
          "SELECT * FROM im_payments WHERE workspace_id=$1 AND status IN ('creating','pending','waiting_for_capture') ORDER BY created_at LIMIT 1",
          [workspaceId],
        )
      ).rows[0];
      // Lost browser state must not create a second charge while the first order is unresolved.
      if (pending) return { ...pending, email: u.email };
      const created = (
        await db.query(
          "INSERT INTO im_payments(id,workspace_id,user_id,request_id,plan_id,amount_kopecks,currency,test,status) VALUES($1,$2,$3,$4,'pro',$5,'RUB',$6,'creating') RETURNING *",
          [
            randomUUID(),
            workspaceId,
            u.id,
            b.requestId,
            c.billing.amountKopecks,
            c.billing.testMode,
          ],
        )
      ).rows[0];
      await audit(db, workspaceId, u.id, "payment.created", created.id);
      return { ...created, email: u.email };
    });
    return { payment: paymentJson(await refresh(row)) };
  });
  app.post(
    "/api/workspaces/:workspaceId/payments/:paymentId/refresh",
    async (req) => {
      const u = (await user(req))!,
        { workspaceId, paymentId } = params(req.params),
        m = await membership(workspaceId, u.id);
      assert(m.role === "owner", 403, "FORBIDDEN", "Недостаточно прав.");
      await requireBudget(limiter, `payment-refresh:${u.id}`, 30, 3600);
      const row = (
        await pool.query(
          'SELECT p.*,u.email FROM im_payments p LEFT JOIN "user" u ON u.id=p.user_id WHERE p.workspace_id=$1 AND p.id=$2',
          [workspaceId, paymentId],
        )
      ).rows[0];
      assert(row, 404, "PAYMENT_NOT_FOUND", "Платеж не найден.");
      return { payment: paymentJson(await refresh(row)) };
    },
  );
  app.post(
    "/api/billing/yookassa/webhook",
    { bodyLimit: 65536 },
    async (req) => {
      assert(
        provider,
        503,
        "BILLING_UNAVAILABLE",
        "Прием платежей не подключен.",
      );
      const body = z
        .object({
          event: z.enum([
            "payment.succeeded",
            "payment.canceled",
            "payment.waiting_for_capture",
            "refund.succeeded",
          ]),
          object: z
            .object({
              id: z.string().max(128),
              payment_id: z.string().max(128).optional(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(req.body);
      const providerId =
        body.event === "refund.succeeded"
          ? body.object.payment_id
          : body.object.id;
      assert(
        providerId &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(providerId),
        400,
        "INVALID_WEBHOOK",
        "Некорректное уведомление.",
      );
      await requireBudget(limiter, "payment-webhook:global", 120, 60);
      await requireBudget(limiter, `payment-webhook:${providerId}`, 20, 60);
      const local = (
        await pool.query("SELECT id FROM im_payments WHERE provider_id=$1", [
          providerId,
        ])
      ).rows[0];
      if (!local) {
        // An early webhook can race storage of the create response. Fetch and verify metadata before linking it.
        const canonical = await provider.getPayment(providerId),
          found = (
            await pool.query("SELECT id FROM im_payments WHERE id=$1", [
              canonical.metadata.paymentId,
            ])
          ).rows[0];
        if (found) await applyProvider(canonical, found.id);
      } else
        await applyProvider(await provider.getPayment(providerId), local.id);
      return { ok: true };
    },
  );
  let running = false;
  async function reconcile() {
    if (!provider || running) return;
    running = true;
    try {
      const rows = (
        await pool.query(
          "SELECT p.*,u.email FROM im_payments p LEFT JOIN \"user\" u ON u.id=p.user_id WHERE p.status IN ('creating','pending','waiting_for_capture') AND p.updated_at<now()-interval '2 minutes' ORDER BY p.updated_at LIMIT 4",
        )
      ).rows;
      for (const row of rows) {
        try {
          await refresh(row);
        } catch {
          await pool.query(
            "UPDATE im_payments SET updated_at=now() WHERE id=$1",
            [row.id],
          );
        }
      }
    } catch (e) {
      app.log.error({ err: e }, "Payment reconciliation failed");
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => void reconcile(), 60000);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}
