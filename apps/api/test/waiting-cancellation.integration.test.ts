import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { harness } from "./suite-harness.js";

const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };
type Ticket = { requestId: string; waitingToken: string };

async function fixture() {
  const h = await harness();
  const owner = await h.signup("waiting-owner@example.test");
  const workspace = await h.workspace(owner.cookie);
  const room = await h.room(owner.cookie, workspace.id, { waitingRoom: true });
  async function ticket() {
    const response = await h.request("POST", `/api/rooms/${room.slug}/join`, {
      name: "Synthetic guest",
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "waiting");
    return response.json() as Ticket;
  }
  async function admit(target: Ticket) {
    const response = await h.request(
      "PATCH",
      `/api/workspaces/${workspace.id}/rooms/${room.id}/waiting/${target.requestId}`,
      { decision: "admitted" },
      owner.cookie,
    );
    assert.equal(response.statusCode, 200, response.body);
  }
  const join = (target: Ticket) =>
    h.request("POST", `/api/rooms/${room.slug}/join`, {
      name: "Synthetic guest",
      waitingToken: target.waitingToken,
    });
  const cancel = (target: Ticket, cookie?: string) =>
    h.request(
      "DELETE",
      `/api/rooms/${room.slug}/waiting`,
      { waitingToken: target.waitingToken },
      cookie,
    );
  return { h, owner, workspace, room, ticket, admit, join, cancel };
}

test(
  "waiting cancellation denies only the unused ticket and stays authoritative when waiting is disabled",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const target = await f.ticket();
      const sibling = await f.ticket();
      await f.admit(target);
      await f.admit(sibling);
      const cancelled = await f.cancel(target);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal((await f.cancel(target)).statusCode, 200);
      const denied = await f.join(target);
      assert.equal(denied.statusCode, 403, denied.body);
      assert.equal(denied.json().error.code, "WAITING_DENIED");
      assert.equal((await f.join(sibling)).statusCode, 200);

      const pending = await f.ticket();
      assert.equal((await f.cancel(pending)).statusCode, 200);
      const lateAdmission = await f.h.request(
        "PATCH",
        `/api/workspaces/${f.workspace.id}/rooms/${f.room.id}/waiting/${pending.requestId}`,
        { decision: "admitted" },
        f.owner.cookie,
      );
      assert.equal(lateAdmission.statusCode, 409, lateAdmission.body);
      assert.equal(lateAdmission.json().error.code, "WAITING_CHANGED");
      assert.equal((await f.join(pending)).statusCode, 403);

      const foreign = await f.h.signup("waiting-outsider@example.test");
      assert.equal((await f.cancel(target, foreign.cookie)).statusCode, 404);
      const otherRoom = await f.h.room(f.owner.cookie, f.workspace.id);
      assert.equal(
        (
          await f.h.request("DELETE", `/api/rooms/${otherRoom.slug}/waiting`, {
            waitingToken: target.waitingToken,
          })
        ).statusCode,
        404,
      );

      const updated = await f.h.request(
        "PATCH",
        `/api/workspaces/${f.workspace.id}/rooms/${f.room.id}`,
        { waitingRoom: false },
        f.owner.cookie,
      );
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(
        (await f.join(target)).statusCode,
        403,
        "turning off the waiting room cannot revive an explicitly cancelled ticket",
      );
      assert.equal(
        (
          await f.h.request("POST", `/api/rooms/${f.room.slug}/join`, {
            name: "Fresh visitor",
          })
        ).statusCode,
        200,
        "a new request without an old ticket still follows the current room policy",
      );
      assert.equal(f.h.retired.length, 0);
    } finally {
      await f.h.close();
    }
  },
);

test(
  "an already consumed waiting ticket cannot return a false cancellation success",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const target = await f.ticket();
      await f.admit(target);
      const joined = await f.join(target);
      assert.equal(joined.statusCode, 200, joined.body);
      const cancelled = await f.cancel(target);
      assert.equal(cancelled.statusCode, 409, cancelled.body);
      assert.equal(
        cancelled.json().error.code,
        "WAITING_CANCELLATION_UNVERIFIED",
      );
      assert.equal((await f.cancel(target)).statusCode, 409);
      const row = (
        await f.h.pool.query(
          "SELECT status,used_at FROM im_waiting_requests WHERE id=$1",
          [target.requestId],
        )
      ).rows[0];
      assert.equal(row.status, "admitted");
      assert.ok(row.used_at);
      assert.equal(f.h.retired.length, 0);
      const chat = await f.h.request(
        "GET",
        `/api/rooms/${f.room.slug}/chat`,
        undefined,
        undefined,
        { "x-imon-room-session": joined.json().chatToken },
      );
      assert.equal(
        chat.statusCode,
        200,
        "this release must not pretend to revoke a grant without signaling enforcement",
      );
    } finally {
      await f.h.close();
    }
  },
);

test(
  "cancel and join serialize on PostgreSQL before deciding whether cancellation succeeded",
  dbTest,
  async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    let joining: ReturnType<typeof f.join> | undefined;
    let cancelling: ReturnType<typeof f.cancel> | undefined;
    try {
      const target = await f.ticket();
      await f.admit(target);
      const token = f.h.media.token.bind(f.h.media);
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.h.media.token = async (...args) => {
        entered();
        await resume;
        return token(...args);
      };
      joining = f.join(target);
      await reached;
      cancelling = f.cancel(target);

      // Observe a real PostgreSQL lock wait instead of assuming that a sleep
      // scheduled both requests. The old handler waits on its ticket UPDATE;
      // the corrected one waits on the workspace lock held by /join.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const activity = await f.h.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND (query LIKE 'UPDATE im_waiting_requests SET status=%' OR query LIKE 'SELECT id FROM im_workspaces WHERE id=$1 FOR NO KEY UPDATE%')",
        );
        blocked = Boolean(activity.rowCount);
        if (!blocked) await delay(10);
      }
      assert.equal(
        blocked,
        true,
        "the cancellation must reach the database lock",
      );
      assert.ok(release);
      release();
      const [joined, cancelled] = await Promise.all([joining, cancelling]);
      assert.equal(joined.statusCode, 200, joined.body);
      assert.equal(cancelled.statusCode, 409, cancelled.body);
      assert.equal(
        cancelled.json().error.code,
        "WAITING_CANCELLATION_UNVERIFIED",
      );
      assert.equal(f.h.retired.length, 0);
    } finally {
      release?.();
      await Promise.allSettled([joining, cancelling].filter(Boolean));
      await f.h.close();
    }
  },
);
