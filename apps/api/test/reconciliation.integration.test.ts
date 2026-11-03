import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EgressStatus, type EgressInfo } from "livekit-server-sdk";
import { harness } from "./suite-harness.js";
import { processPaymentChecks } from "../src/payment-checks.js";
import { ApiError } from "../src/policy.js";
const opts = { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 };

test(
  "owner reconciliation binds canonical evidence, survives missing webhooks, preserves partial refunds and excludes other tenants",
  opts,
  async () => {
    const providerId = randomUUID();
    let posted: Record<string, any> | undefined,
      posts = 0,
      gets = 0,
      refunded = "0.00",
      state = "succeeded";
    let wrongAmount = false,
      wrongId = false,
      demote: (() => Promise<void>) | undefined;
    const request = (async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        posted = JSON.parse(String(init.body));
        throw new Error("Ambiguous response after provider accepted create");
      }
      gets++;
      assert.equal(
        String(url),
        "https://api.yookassa.ru/v3/payments/" + providerId,
      );
      if (demote) {
        const run = demote;
        demote = undefined;
        await run();
      }
      return Response.json({
        id: wrongId ? randomUUID() : providerId,
        status: state,
        paid: state === "succeeded",
        test: true,
        amount: {
          value: wrongAmount ? "1.00" : posted!.amount.value,
          currency: "RUB",
        },
        recipient: { account_id: "12345" },
        metadata: posted!.metadata,
        created_at: "2026-11-01T10:00:00.000Z",
        refunded_amount: { value: refunded, currency: "RUB" },
      });
    }) as typeof fetch;
    const h = await harness(
      {
        APP_URL: "https://imonmeets.test",
        BILLING_ENABLED: "true",
        YOOKASSA_SHOP_ID: "12345",
        YOOKASSA_SECRET_KEY: "test-provider-secret-not-a-real-key",
        YOOKASSA_TEST_MODE: "true",
        BILLING_PRO_PRICE_KOPECKS: "149000",
      },
      request,
    );
    try {
      const owner = await h.signup("reconcile-owner@example.test"),
        other = await h.signup("reconcile-other@example.test");
      const w = await h.workspace(owner.cookie),
        w2 = await h.workspace(other.cookie);
      const created = await h.request(
        "POST",
        "/api/workspaces/" + w.id + "/payments",
        { planId: "pro", requestId: randomUUID() },
        owner.cookie,
      );
      assert.equal(created.statusCode, 503);
      const local = (
        await h.pool.query("SELECT * FROM im_payments WHERE workspace_id=$1", [
          w.id,
        ])
      ).rows[0];
      await h.pool.query(
        "UPDATE im_payments SET created_at=now()-interval '2 days' WHERE id=$1",
        [local.id],
      );
      const refreshPath =
        "/api/workspaces/" + w.id + "/payments/" + local.id + "/refresh";
      const reviewPath =
        "/api/workspaces/" + w.id + "/payments/" + local.id + "/reconcile";
      const refresh = await h.request("POST", refreshPath, {}, owner.cookie);
      assert.equal(refresh.statusCode, 503);
      assert.equal(refresh.json().error.code, "PAYMENT_REVIEW_REQUIRED");
      assert.equal(
        posts,
        1,
        "Expired idempotency window must never repeat POST",
      );
      const body = { providerPaymentId: providerId };
      assert.equal(
        (await h.request("POST", reviewPath, body, other.cookie)).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            "/api/workspaces/" + w2.id + "/payments/" + local.id + "/reconcile",
            body,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(gets, 0);
      const first = await h.request("POST", reviewPath, body, owner.cookie);
      assert.equal(first.statusCode, 200, first.body);
      const preview = first.json();
      assert.match(preview.version, /^[a-f0-9]{64}$/);
      assert.equal(
        (
          await h.pool.query(
            "SELECT provider_id,applied_at FROM im_payments WHERE id=$1",
            [local.id],
          )
        ).rows[0].provider_id,
        null,
      );
      const apply = {
        ...body,
        apply: true,
        version: preview.version,
        previewAuditId: preview.auditId,
      };
      state = "pending";
      const changed = await h.request("POST", reviewPath, apply, owner.cookie);
      assert.equal(changed.statusCode, 409, changed.body);
      assert.equal(changed.json().error.code, "REVIEW_CHANGED");
      state = "succeeded";
      wrongAmount = true;
      assert.equal(
        (await h.request("POST", reviewPath, body, owner.cookie)).statusCode,
        409,
      );
      wrongAmount = false;
      wrongId = true;
      assert.equal(
        (await h.request("POST", reviewPath, body, owner.cookie)).statusCode,
        503,
      );
      wrongId = false;
      demote = async () => {
        await h.pool.query(
          "UPDATE im_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [w.id, owner.id],
        );
      };
      assert.equal(
        (await h.request("POST", reviewPath, apply, owner.cookie)).statusCode,
        403,
        "Fresh role must be checked after provider GET",
      );
      await h.pool.query(
        "UPDATE im_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
        [w.id, owner.id],
      );
      const applied = await h.request("POST", reviewPath, apply, owner.cookie);
      assert.equal(applied.statusCode, 200, applied.body);
      assert.equal(applied.json().payment.status, "succeeded");
      assert.notEqual(applied.json().auditId, preview.auditId);
      assert.equal(
        (await h.request("POST", reviewPath, apply, owner.cookie)).statusCode,
        409,
      );
      assert.equal(posts, 1);
      const paidUntil = (
        await h.pool.query(
          "SELECT paid_until FROM im_workspace_plans WHERE workspace_id=$1",
          [w.id],
        )
      ).rows[0].paid_until.getTime();
      const due = async () =>
        h.pool.query(
          "UPDATE im_payments SET next_check_at=now()-interval '1 second' WHERE id=$1",
          [local.id],
        );
      const check = async (row: Record<string, any>) => {
        assert.equal(row.id, local.id);
        const r = await h.request("POST", refreshPath, {}, owner.cookie);
        assert.equal(r.statusCode, 200, r.body);
      };
      refunded = "500.00";
      await due();
      assert.deepEqual(await processPaymentChecks(h.pool, check), {
        checked: 1,
        failed: 0,
      });
      let payment = (
        await h.pool.query("SELECT * FROM im_payments WHERE id=$1", [local.id])
      ).rows[0];
      assert.equal(payment.status, "succeeded");
      assert.equal(Number(payment.refunded_kopecks), 50000);
      assert.equal(payment.reversed_at, null);
      assert.equal(
        (
          await h.pool.query(
            "SELECT paid_until FROM im_workspace_plans WHERE workspace_id=$1",
            [w.id],
          )
        ).rows[0].paid_until.getTime(),
        paidUntil,
      );
      refunded = "0.00";
      assert.equal(
        (await h.request("POST", refreshPath, {}, owner.cookie)).json().payment
          .refundedKopecks,
        50000,
        "Stale provider response cannot erase refund amount",
      );
      refunded = "1490.00";
      await due();
      assert.deepEqual(await processPaymentChecks(h.pool, check), {
        checked: 1,
        failed: 0,
      });
      payment = (
        await h.pool.query("SELECT * FROM im_payments WHERE id=$1", [local.id])
      ).rows[0];
      assert.equal(payment.status, "refunded");
      assert.ok(payment.reversed_at);
      assert.equal(Number(payment.refunded_kopecks), 149000);
      assert.equal(payment.next_check_at, null);
      assert.ok(
        (
          await h.pool.query(
            "SELECT paid_until FROM im_workspace_plans WHERE workspace_id=$1",
            [w.id],
          )
        ).rows[0].paid_until.getTime() <
          Date.now() + 2000,
      );
      const receipts = (
        await h.pool.query(
          "SELECT event,reconciliation_version FROM im_audit WHERE resource_id=$1 AND reconciliation_version IS NOT NULL",
          [local.id],
        )
      ).rows;
      assert.ok(
        receipts.some(
          (row) =>
            row.event === "payment.reconciliation.applied" &&
            row.reconciliation_version === preview.version,
        ),
      );
      let limited = false;
      for (let i = 0; i < 13; i++) {
        const prior = gets,
          r = await h.request("POST", reviewPath, body, owner.cookie);
        if (r.statusCode === 429) {
          assert.equal(gets, prior);
          assert.ok(r.headers["retry-after"]);
          limited = true;
          break;
        }
        assert.equal(r.statusCode, 200, r.body);
      }
      assert.ok(limited, "Owner review must have bounded external GET budget");

      const pendingIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = randomUUID();
        pendingIds.push(id);
        await h.pool.query(
          "INSERT INTO im_payments(id,workspace_id,user_id,request_id,plan_id,amount_kopecks,currency,test,status,created_at) VALUES($1,$2,$3,$4,'pro',149000,'RUB',true,'creating',now()-interval '2 days')",
          [id, w.id, owner.id, randomUUID()],
        );
      }
      const seen: string[] = [];
      const unavailable = async (row: Record<string, any>) => {
        seen.push(row.id);
        throw new ApiError(
          503,
          "PAYMENT_REVIEW_REQUIRED",
          "Provider evidence required",
        );
      };
      await Promise.all([
        processPaymentChecks(h.pool, unavailable),
        processPaymentChecks(h.pool, unavailable),
      ]);
      assert.equal(new Set(seen).size, 6);
      assert.equal(seen.length, 6);
      const safe = (
        await h.pool.query(
          "SELECT * FROM im_payments WHERE id=ANY($1::text[])",
          [pendingIds],
        )
      ).rows;
      assert.ok(
        safe.every(
          (row) =>
            row.status === "creating" &&
            row.provider_id === null &&
            row.last_check_error === "PAYMENT_REVIEW_REQUIRED" &&
            row.check_lease_token === null &&
            row.next_check_at.getTime() > Date.now() + 23 * 3600 * 1000,
        ),
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "recording reconciliation requires exact persisted generation and output, current owner, review version and positive provider evidence",
  opts,
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("egress-review@example.test"),
        other = await h.signup("egress-other@example.test");
      const w = await h.workspace(owner.cookie),
        room = await h.room(owner.cookie, w.id);
      const id = randomUUID(),
        egressId = "EG_reconcile_1",
        key = "recordings/" + w.id + "/" + id + ".mp4";
      const mediaName = room.id + "-g1";
      await h.pool.query("UPDATE im_rooms SET media_generation=2 WHERE id=$1", [
        room.id,
      ]);
      await h.pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,media_name,status,object_key) VALUES($1,$2,$3,$4,'starting',$5)",
        [id, w.id, room.id, mediaName, key],
      );
      let jobs: EgressInfo[] = [],
        reads = 0;
      h.media.egress.listEgress = async (options) => {
        reads++;
        assert.deepEqual(options, { egressId });
        return jobs;
      };
      const path =
          "/api/workspaces/" + w.id + "/recordings/" + id + "/reconcile",
        body = { egressId };
      assert.equal(
        (await h.request("POST", path, body, other.cookie)).statusCode,
        404,
      );
      assert.equal(reads, 0);
      assert.equal(
        (await h.request("POST", path, body, owner.cookie)).statusCode,
        503,
      );
      const info = {
        egressId,
        roomName: room.id + "-g2",
        status: EgressStatus.EGRESS_COMPLETE,
        fileResults: [{ filename: key, size: 321n }],
        request: { case: undefined },
      } as EgressInfo;
      jobs = [info];
      assert.equal(
        (await h.request("POST", path, body, owner.cookie)).statusCode,
        409,
      );
      info.roomName = mediaName;
      info.fileResults[0]!.filename = "wrong-file.mp4";
      assert.equal(
        (await h.request("POST", path, body, owner.cookie)).statusCode,
        409,
      );
      info.fileResults[0]!.filename = key;
      await h.pool.query(
        "UPDATE im_recordings SET media_name=NULL WHERE id=$1",
        [id],
      );
      const unknown = await h.request("POST", path, body, owner.cookie);
      assert.equal(unknown.statusCode, 409);
      assert.equal(unknown.json().error.code, "RECORDING_GENERATION_UNKNOWN");
      await h.pool.query("UPDATE im_recordings SET media_name=$2 WHERE id=$1", [
        id,
        mediaName,
      ]);
      const r = await h.request("POST", path, body, owner.cookie);
      assert.equal(r.statusCode, 200, r.body);
      const preview = r.json();
      assert.equal(
        (
          await h.pool.query(
            "SELECT status,egress_id FROM im_recordings WHERE id=$1",
            [id],
          )
        ).rows[0].status,
        "starting",
      );
      const apply = {
        ...body,
        apply: true,
        previewAuditId: preview.auditId,
        version: preview.version,
      };
      info.fileResults[0]!.size = 322n;
      assert.equal(
        (await h.request("POST", path, apply, owner.cookie)).statusCode,
        409,
      );
      info.fileResults[0]!.size = 321n;
      h.media.egress.listEgress = async () => {
        await h.pool.query(
          "UPDATE im_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
          [w.id, owner.id],
        );
        return jobs;
      };
      assert.equal(
        (await h.request("POST", path, apply, owner.cookie)).statusCode,
        403,
      );
      await h.pool.query(
        "UPDATE im_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
        [w.id, owner.id],
      );
      h.media.egress.listEgress = async () => jobs;
      const applied = await h.request("POST", path, apply, owner.cookie);
      assert.equal(applied.statusCode, 200, applied.body);
      assert.equal(applied.json().recording.status, "complete");
      const row = (
        await h.pool.query("SELECT * FROM im_recordings WHERE id=$1", [id])
      ).rows[0];
      assert.equal(row.egress_id, egressId);
      assert.equal(row.media_name, mediaName);
      assert.equal(String(row.size_bytes), "321");
      assert.equal(
        (await h.request("POST", path, apply, owner.cookie)).statusCode,
        409,
      );
    } finally {
      await h.close();
    }
  },
);
