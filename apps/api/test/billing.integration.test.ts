import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness, password } from "./suite-harness.js";
import { workspaceLimits } from "../src/billing.js";
const opts = { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 };
test(
  "billing uses durable order idempotency, canonical provider verification, exact-once entitlement, tenant isolation and refund reversal",
  opts,
  async () => {
    let ambiguous = true,
      status = "pending",
      refunded = "0.00",
      tamper = false;
    let body: Record<string, any> | undefined;
    const id = randomUUID(),
      idempotency: string[] = [],
      providerRequest = (async (input, init) => {
        assert.ok(
          String(input).startsWith("https://api.yookassa.ru/v3/payments"),
        );
        if (init?.method === "POST") {
          body = JSON.parse(String(init.body));
          idempotency.push(new Headers(init.headers).get("Idempotence-Key")!);
          if (ambiguous) {
            ambiguous = false;
            throw new Error("Connection lost after provider received request");
          }
        }
        assert.ok(body);
        return new Response(
          JSON.stringify({
            id,
            status,
            paid: status === "succeeded",
            test: true,
            amount: {
              value: tamper ? "0.01" : body!.amount.value,
              currency: "RUB",
            },
            recipient: { account_id: "12345" },
            metadata: body!.metadata,
            created_at: new Date().toISOString(),
            ...(status === "succeeded"
              ? { captured_at: new Date().toISOString() }
              : {}),
            confirmation: {
              type: "redirect",
              confirmation_url: "https://yoomoney.ru/checkout/test",
            },
            refunded_amount: { value: refunded, currency: "RUB" },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;
    const h = await harness(
      {
        APP_URL: "https://imonmeets.test",
        BILLING_ENABLED: "true",
        YOOKASSA_SHOP_ID: "12345",
        YOOKASSA_SECRET_KEY: "test-provider-secret-not-a-real-key",
        YOOKASSA_TEST_MODE: "true",
        BILLING_PRO_PRICE_KOPECKS: "149000",
        BILLING_FREE_ROOMS: "1",
        BILLING_FREE_MEMBERS: "2",
        BILLING_FREE_PARTICIPANTS: "10",
      },
      providerRequest,
    );
    try {
      const owner = await h.signup("payer-suite@example.com"),
        other = await h.signup("payer-other@example.com"),
        w = await h.workspace(owner.cookie),
        w2 = await h.workspace(other.cookie);
      const before = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/plan`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(before.plan.id, "free");
      assert.equal(before.offer.amountKopecks, 149000);
      assert.equal(before.billingEnabled, true);
      assert.equal(before.testMode, true);
      const room = await h.room(owner.cookie, w.id, { maxParticipants: 10 });
      const overLimit = await h.request(
        "POST",
        `/api/workspaces/${w.id}/rooms`,
        { title: "Over limit" },
        owner.cookie,
      );
      assert.equal(overLimit.statusCode, 409);
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/payments`,
            { planId: "pro", requestId: randomUUID(), amountKopecks: 1 },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/payments`,
            { planId: "pro", requestId: randomUUID() },
            other.cookie,
          )
        ).statusCode,
        404,
      );
      const requestId = randomUUID(),
        first = await h.request(
          "POST",
          `/api/workspaces/${w.id}/payments`,
          { planId: "pro", requestId },
          owner.cookie,
        );
      assert.equal(first.statusCode, 503, first.body);
      const pending = await h.request(
        "POST",
        `/api/workspaces/${w.id}/payments`,
        { planId: "pro", requestId: randomUUID() },
        owner.cookie,
      );
      assert.equal(pending.statusCode, 200, pending.body);
      const localId = pending.json().payment.id;
      assert.equal(idempotency.length, 2);
      assert.equal(idempotency[0], idempotency[1]);
      assert.equal(idempotency[0], localId);
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_payments WHERE workspace_id=$1",
            [w.id],
          )
        ).rows[0].n,
        1,
      );
      const cannotDeletePending = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}`,
        { password, confirmation: "DELETE" },
        owner.cookie,
      );
      assert.equal(cannotDeletePending.statusCode, 409);
      assert.equal(cannotDeletePending.json().error.code, "PAYMENT_PENDING");
      const fakeSuccess = {
        event: "payment.succeeded",
        object: { id, status: "succeeded", paid: true },
      };
      const forged = await h.app.inject({
        method: "POST",
        url: "/api/billing/yookassa/webhook",
        payload: fakeSuccess,
      });
      assert.equal(forged.statusCode, 200, forged.body);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/plan`,
            undefined,
            owner.cookie,
          )
        ).json().plan.id,
        "free",
      );
      tamper = true;
      status = "succeeded";
      const mismatch = await h.request(
        "POST",
        `/api/workspaces/${w.id}/payments/${localId}/refresh`,
        {},
        owner.cookie,
      );
      assert.equal(mismatch.statusCode, 409, mismatch.body);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/plan`,
            undefined,
            owner.cookie,
          )
        ).json().plan.id,
        "free",
      );
      tamper = false;
      const paid = await h.request(
        "POST",
        `/api/workspaces/${w.id}/payments/${localId}/refresh`,
        {},
        owner.cookie,
      );
      assert.equal(paid.statusCode, 200, paid.body);
      assert.ok(paid.json().payment.appliedAt);
      const after = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/plan`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(after.plan.id, "pro");
      const providerDisabled = {
        ...h.c,
        billingConfigured: false,
        billing: { ...h.c.billing, commercial: false },
      };
      assert.equal(
        (await workspaceLimits(h.pool, providerDisabled, w.id)).participants,
        h.c.billing.proLimits.participants,
      );
      const personal = (
        await h.request("GET", "/api/me/export", undefined, owner.cookie)
      ).json();
      assert.equal(personal.payments[0].id, localId);
      assert.ok(
        new Date(after.paidUntil).getTime() > Date.now() + 29 * 86400000,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/payments/${localId}/refresh`,
            {},
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/plan`,
            undefined,
            owner.cookie,
          )
        ).json().paidUntil,
        after.paidUntil,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w2.id}/payments/${localId}/refresh`,
            {},
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/rooms`,
            { title: "Pro room", maxParticipants: 100 },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      refunded = "1490.00";
      const refund = await h.app.inject({
        method: "POST",
        url: "/api/billing/yookassa/webhook",
        payload: {
          event: "refund.succeeded",
          object: { id: randomUUID(), payment_id: id },
        },
      });
      assert.equal(refund.statusCode, 200, refund.body);
      const reversed = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/plan`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(reversed.plan.id, "free");
      assert.equal(reversed.payments[0].status, "refunded");
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/payments/${localId}/refresh`,
            {},
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_audit WHERE workspace_id=$1 AND event='payment.applied'",
            [w.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_audit WHERE workspace_id=$1 AND event='payment.refunded'",
            [w.id],
          )
        ).rows[0].n,
        1,
      );
      await h.pool.query(
        "INSERT INTO im_payments(id,workspace_id,user_id,request_id,plan_id,amount_kopecks,currency,test,status,created_at) VALUES($1,$2,$3,$4,'pro',149000,'RUB',true,'creating',now()-interval '25 hours')",
        [randomUUID(), w.id, owner.id, randomUUID()],
      );
      const ambiguousOld = (
        await h.pool.query(
          "SELECT id FROM im_payments WHERE workspace_id=$1 AND status='creating'",
          [w.id],
        )
      ).rows[0];
      const cutoff = await h.request(
        "POST",
        `/api/workspaces/${w.id}/payments/${ambiguousOld.id}/refresh`,
        {},
        owner.cookie,
      );
      assert.equal(cutoff.statusCode, 503);
      assert.equal(cutoff.json().error.code, "PAYMENT_REVIEW_REQUIRED");
      assert.equal(idempotency.length, 2);
      await h.pool.query(
        "UPDATE im_payments SET status='canceled' WHERE id=$1",
        [ambiguousOld.id],
      );
      const deletion = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}`,
        { password, confirmation: "DELETE" },
        owner.cookie,
      );
      assert.equal(deletion.statusCode, 200, deletion.body);
      assert.equal(
        (await h.pool.query("SELECT 1 FROM im_payments WHERE id=$1", [localId]))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/plan`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        404,
      );
      const lateRefund = await h.app.inject({
        method: "POST",
        url: "/api/billing/yookassa/webhook",
        payload: {
          event: "refund.succeeded",
          object: { id: randomUUID(), payment_id: id },
        },
      });
      assert.equal(lateRefund.statusCode, 200, lateRefund.body);
      assert.ok(room.id);
    } finally {
      await h.close();
    }
  },
);

test(
  "refunds preserve later purchases, consumed historical periods, and terminal state under stale responses",
  opts,
  async () => {
    const records = new Map<string, Record<string, unknown>>();
    const request = (async (input) => {
      const id = new URL(String(input)).pathname.split("/").at(-1)!;
      assert.ok(records.has(id));
      return new Response(JSON.stringify(records.get(id)), {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const h = await harness(
      {
        APP_URL: "https://imonmeets.test",
        BILLING_ENABLED: "true",
        YOOKASSA_SHOP_ID: "12345",
        YOOKASSA_SECRET_KEY: "test-provider-secret-not-a-real-key",
        YOOKASSA_TEST_MODE: "true",
      },
      request,
    );
    try {
      const owner = await h.signup("refund-periods@example.com"),
        w = await h.workspace(owner.cookie);
      async function stored(start: string, end: string) {
        const id = randomUUID(),
          providerId = randomUUID();
        await h.pool.query(
          "INSERT INTO im_payments(id,workspace_id,user_id,request_id,plan_id,amount_kopecks,currency,test,provider_id,status,applied_at,entitlement_start,entitlement_end) VALUES($1,$2,$3,$4,'pro',149000,'RUB',true,$5,'succeeded','2000-01-01T00:00:00Z',$6,$7)",
          [id, w.id, owner.id, randomUUID(), providerId, start, end],
        );
        records.set(providerId, {
          id: providerId,
          status: "succeeded",
          paid: true,
          test: true,
          amount: { value: "1490.00", currency: "RUB" },
          recipient: { account_id: "12345" },
          metadata: {
            paymentId: id,
            workspaceId: w.id,
            planId: "pro",
            userId: owner.id,
          },
          created_at: "2000-01-01T00:00:00Z",
          captured_at: "2000-01-01T00:00:00Z",
          refunded_amount: { value: "1490.00", currency: "RUB" },
        });
        return { id, providerId };
      }
      const first = await stored(
          "2099-01-01T00:00:00Z",
          "2099-01-31T00:00:00Z",
        ),
        second = await stored("2099-01-31T00:00:00Z", "2099-03-02T00:00:00Z"),
        third = await stored("2099-03-02T00:00:00Z", "2099-04-01T00:00:00Z"),
        historical = await stored(
          "2000-01-01T00:00:00Z",
          "2000-01-31T00:00:00Z",
        );
      await h.pool.query(
        "UPDATE im_workspace_plans SET plan_id='pro',paid_until='2099-04-01T00:00:00Z' WHERE workspace_id=$1",
        [w.id],
      );
      const refresh = async (id: string) => {
        const r = await h.request(
          "POST",
          `/api/workspaces/${w.id}/payments/${id}/refresh`,
          {},
          owner.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        return r.json();
      };
      await refresh(first.id);
      const plan = () =>
        h.pool.query(
          "SELECT paid_until FROM im_workspace_plans WHERE workspace_id=$1",
          [w.id],
        );
      assert.equal(
        (await plan()).rows[0].paid_until.toISOString(),
        "2099-03-02T00:00:00.000Z",
      );
      const secondWindow = (
        await h.pool.query(
          "SELECT entitlement_start,entitlement_end FROM im_payments WHERE id=$1",
          [second.id],
        )
      ).rows[0];
      assert.equal(
        secondWindow.entitlement_start.toISOString(),
        "2099-01-01T00:00:00.000Z",
      );
      assert.equal(
        secondWindow.entitlement_end.toISOString(),
        "2099-01-31T00:00:00.000Z",
      );
      await refresh(historical.id);
      assert.equal(
        (await plan()).rows[0].paid_until.toISOString(),
        "2099-03-02T00:00:00.000Z",
      );
      await refresh(second.id);
      assert.equal(
        (await plan()).rows[0].paid_until.toISOString(),
        "2099-01-31T00:00:00.000Z",
      );
      const thirdWindow = (
        await h.pool.query(
          "SELECT entitlement_start,entitlement_end FROM im_payments WHERE id=$1",
          [third.id],
        )
      ).rows[0];
      assert.equal(
        thirdWindow.entitlement_start.toISOString(),
        "2099-01-01T00:00:00.000Z",
      );
      assert.equal(
        thirdWindow.entitlement_end.toISOString(),
        "2099-01-31T00:00:00.000Z",
      );
      const oldResponse = records.get(first.providerId)!;
      oldResponse.refunded_amount = { value: "0.00", currency: "RUB" };
      assert.equal((await refresh(first.id)).payment.status, "refunded");
      assert.equal(
        (await plan()).rows[0].paid_until.toISOString(),
        "2099-01-31T00:00:00.000Z",
      );
    } finally {
      await h.close();
    }
  },
);
