import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AccessToken } from "livekit-server-sdk";
import { harness, responseCookie } from "./suite-harness.js";

const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };
const signalingSecret = "synthetic-waiting-cancellation-signaling-secret";
type Harness = Awaited<ReturnType<typeof harness>>;
type Ticket = { requestId: string; waitingToken: string };
type Grant = {
  token: string;
  chatToken: string;
  identity: string;
  roomName: string;
};

async function fixture(enabled = true) {
  const h = await harness(
    enabled
      ? {
          LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
          LIVEKIT_SIGNALING_AUTH_SECRET: signalingSecret,
        }
      : {},
  );
  const owner = await h.signup("waiting-owner@example.test");
  const workspace = await h.workspace(owner.cookie);
  const room = await h.room(owner.cookie, workspace.id, { waitingRoom: true });
  const removeCalls: { room: string; identity: string }[] = [];
  h.media.rooms.removeParticipant = async (room, identity) => {
    removeCalls.push({ room, identity });
  };
  async function ticket(cookie?: string) {
    const response = await h.request(
      "POST",
      `/api/rooms/${room.slug}/join`,
      { name: "Synthetic guest" },
      cookie,
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, "waiting");
    return {
      ...(response.json() as Ticket),
      cookie: responseCookie(response, cookie),
    };
  }
  async function admit(ticket: Ticket) {
    const response = await h.request(
      "PATCH",
      `/api/workspaces/${workspace.id}/rooms/${room.id}/waiting/${ticket.requestId}`,
      { decision: "admitted" },
      owner.cookie,
    );
    assert.equal(response.statusCode, 200, response.body);
  }
  async function join(ticket: Ticket, cookie?: string) {
    return h.request(
      "POST",
      `/api/rooms/${room.slug}/join`,
      { name: "Synthetic guest", waitingToken: ticket.waitingToken },
      cookie,
    );
  }
  async function cancel(ticket: Ticket, cookie?: string) {
    return h.request(
      "DELETE",
      `/api/rooms/${room.slug}/waiting`,
      { waitingToken: ticket.waitingToken },
      cookie,
    );
  }
  return {
    h,
    owner,
    workspace,
    room,
    removeCalls,
    ticket,
    admit,
    join,
    cancel,
  };
}

function gate(h: Harness, token: string) {
  return h.request(
    "GET",
    "/api/internal/livekit/authorize",
    undefined,
    undefined,
    {
      "x-imon-livekit-auth": signalingSecret,
      authorization: "Bearer " + token,
    },
  );
}

test(
  "waiting cancel revokes exactly its consumed grant, preserves another tab, and is idempotent",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const target = await f.ticket();
      const sibling = await f.ticket(target.cookie);
      await f.admit(target);
      await f.admit(sibling);
      const targetResponse = await f.join(target, target.cookie);
      const siblingResponse = await f.join(sibling, sibling.cookie);
      assert.equal(targetResponse.statusCode, 200, targetResponse.body);
      assert.equal(siblingResponse.statusCode, 200, siblingResponse.body);
      const grant = targetResponse.json() as Grant;
      const other = siblingResponse.json() as Grant;
      assert.equal((await gate(f.h, grant.token)).statusCode, 204);
      assert.equal((await gate(f.h, other.token)).statusCode, 204);
      const cancelled = await f.cancel(target, target.cookie);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(
        (await gate(f.h, grant.token)).statusCode,
        403,
        "A consumed ticket cancellation must revoke its already-issued media grant",
      );
      assert.equal(
        (await gate(f.h, other.token)).statusCode,
        204,
        "Cancelling one tab must not revoke another grant for the same guest browser",
      );
      assert.equal(
        (
          await f.h.request(
            "GET",
            `/api/rooms/${f.room.slug}/chat`,
            undefined,
            target.cookie,
            { "x-imon-room-session": grant.chatToken },
          )
        ).statusCode,
        403,
      );
      const refreshed = new AccessToken(
        f.h.c.livekit.apiKey,
        f.h.c.livekit.apiSecret,
        { identity: grant.identity, ttl: 60 },
      );
      refreshed.addGrant({ roomJoin: true, room: grant.roomName });
      assert.equal(
        (await gate(f.h, await refreshed.toJwt())).statusCode,
        403,
        "A newly signed JWT must not revive the cancelled identity",
      );
      assert.ok(f.removeCalls.some((call) => call.identity === grant.identity));
      assert.ok(
        f.removeCalls.every((call) => call.identity === grant.identity),
      );
      assert.equal((await f.cancel(target, target.cookie)).statusCode, 200);
      assert.equal((await gate(f.h, other.token)).statusCode, 204);
      assert.equal(
        f.h.retired.length,
        0,
        "Cancellation must not rotate or delete the whole media room",
      );
      const foreign = await f.h.signup("waiting-other@example.test");
      assert.equal((await f.cancel(sibling, foreign.cookie)).statusCode, 404);
      assert.equal((await gate(f.h, other.token)).statusCode, 204);
      const differentRoom = await f.h.room(f.owner.cookie, f.workspace.id, {
        waitingRoom: true,
      });
      assert.equal(
        (
          await f.h.request(
            "DELETE",
            `/api/rooms/${differentRoom.slug}/waiting`,
            { waitingToken: sibling.waitingToken },
            sibling.cookie,
          )
        ).statusCode,
        404,
      );
    } finally {
      await f.h.close();
    }
  },
);

test(
  "cancel and join serialize across a real locked PostgreSQL transaction",
  dbTest,
  async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    let joining: ReturnType<typeof f.join> | undefined;
    let cancelling: ReturnType<typeof f.cancel> | undefined;
    try {
      const ticket = await f.ticket();
      await f.admit(ticket);
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
      joining = f.join(ticket, ticket.cookie);
      await reached;
      cancelling = f.cancel(ticket, ticket.cookie);
      // Both versions block: the old one on ticket UPDATE, the fixed one on
      // workspace lock. This is a scheduling barrier, not a result assertion.
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
        "Cancel must reach PostgreSQL while join owns the admission locks",
      );
      assert.ok(release, "The deferred join gate must be initialized");
      release();
      const [joined, cancelled] = await Promise.all([joining, cancelling]);
      assert.equal(joined.statusCode, 200, joined.body);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      const grant = joined.json() as Grant;
      assert.equal(
        (await gate(f.h, grant.token)).statusCode,
        403,
        "The completed cancellation must invalidate the grant committed by the racing join",
      );
      assert.ok(f.removeCalls.some((call) => call.identity === grant.identity));
      assert.equal((await f.join(ticket, ticket.cookie)).statusCode, 410);
    } finally {
      release?.();
      await Promise.allSettled([joining, cancelling].filter(Boolean));
      await f.h.close();
    }
  },
);

test(
  "cancellation before admission is final; uncertain removal retains a precise durable retry",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const unused = await f.ticket();
      assert.equal((await f.cancel(unused, unused.cookie)).statusCode, 200);
      assert.equal((await f.join(unused, unused.cookie)).statusCode, 403);
      assert.equal(
        (
          await f.h.request(
            "PATCH",
            `/api/workspaces/${f.workspace.id}/rooms/${f.room.id}/waiting/${unused.requestId}`,
            { decision: "admitted" },
            f.owner.cookie,
          )
        ).statusCode,
        409,
      );
      assert.equal(f.removeCalls.length, 0);
      const target = await f.ticket();
      await f.admit(target);
      const joined = await f.join(target, target.cookie);
      assert.equal(joined.statusCode, 200, joined.body);
      const grant = joined.json() as Grant;
      f.h.media.rooms.removeParticipant = async () => {
        throw new Error("synthetic media timeout");
      };
      const pending = await f.cancel(target, target.cookie);
      assert.equal(
        pending.statusCode,
        503,
        "Uncertain media removal must not report a completed disconnect",
      );
      assert.equal(pending.json().error.code, "WAITING_CANCELLATION_PENDING");
      assert.equal(
        (await gate(f.h, grant.token)).statusCode,
        403,
        "A media timeout must not roll back credential revocation",
      );
      const jobs = await f.h.pool.query(
        "SELECT room_id,media_name,identity FROM im_participant_removals",
      );
      assert.deepEqual(jobs.rows, [
        {
          room_id: f.room.id,
          media_name: grant.roomName,
          identity: grant.identity,
        },
      ]);
      f.h.media.rooms.removeParticipant = async (room, identity) => {
        f.removeCalls.push({ room, identity });
      };
      assert.equal((await f.cancel(target, target.cookie)).statusCode, 200);
      assert.equal(
        (await f.h.pool.query("SELECT 1 FROM im_participant_removals"))
          .rowCount,
        0,
      );
    } finally {
      await f.h.close();
    }
  },
);

test(
  "a presented waiting ticket stays bound when the room stops requiring admission",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const ticket = await f.ticket();
      await f.admit(ticket);
      await f.h.pool.query(
        "UPDATE im_rooms SET waiting_room=false WHERE id=$1",
        [f.room.id],
      );
      const joined = await f.join(ticket, ticket.cookie);
      assert.equal(joined.statusCode, 200, joined.body);
      const grant = joined.json() as Grant;
      const cancelled = await f.cancel(ticket, ticket.cookie);
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.equal(
        (await gate(f.h, grant.token)).statusCode,
        403,
        "Changing room admission policy must not detach a grant from its supplied ticket",
      );
      assert.notEqual(
        (await f.join(ticket, ticket.cookie)).statusCode,
        200,
        "A consumed or cancelled ticket cannot be silently ignored by a less restrictive policy",
      );
      const fresh = await f.h.request(
        "POST",
        `/api/rooms/${f.room.slug}/join`,
        { name: "New explicit attempt" },
        ticket.cookie,
      );
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.equal(
        (await gate(f.h, fresh.json().token)).statusCode,
        204,
        "A new explicit join still follows the current public-room policy",
      );
    } finally {
      await f.h.close();
    }
  },
);

test(
  "legacy consumed tickets do not guess identities or revoke sibling grants",
  dbTest,
  async () => {
    const f = await fixture();
    try {
      const ticket = await f.ticket();
      await f.admit(ticket);
      const joined = await f.join(ticket, ticket.cookie);
      assert.equal(joined.statusCode, 200, joined.body);
      const grant = joined.json() as Grant;
      // The additive migration leaves existing consumed records unbound.
      await f.h.pool.query(
        "UPDATE im_waiting_requests SET issued_identity=NULL WHERE id=$1",
        [ticket.requestId],
      );
      const cancelled = await f.cancel(ticket, ticket.cookie);
      assert.equal(cancelled.statusCode, 409, cancelled.body);
      assert.equal(
        cancelled.json().error.code,
        "WAITING_CANCELLATION_UNVERIFIED",
      );
      assert.equal((await gate(f.h, grant.token)).statusCode, 204);
      assert.equal(f.removeCalls.length, 0);
    } finally {
      await f.h.close();
    }
  },
);

test(
  "disabled signaling protection cannot claim enforced revocation of a consumed ticket",
  dbTest,
  async () => {
    const f = await fixture(false);
    try {
      const ticket = await f.ticket();
      await f.admit(ticket);
      const joined = await f.join(ticket, ticket.cookie);
      assert.equal(joined.statusCode, 200, joined.body);
      const grant = joined.json() as Grant;
      const cancelled = await f.cancel(ticket, ticket.cookie);
      assert.equal(cancelled.statusCode, 503, cancelled.body);
      assert.equal(
        cancelled.json().error.code,
        "WAITING_REVOCATION_UNAVAILABLE",
      );
      const session = await f.h.pool.query(
        "SELECT revoked_at FROM im_chat_sessions WHERE identity=$1",
        [grant.identity],
      );
      assert.ok(
        session.rows[0].revoked_at,
        "The durable local cancellation is still retained",
      );
      assert.equal(f.h.retired.length, 0);
    } finally {
      await f.h.close();
    }
  },
);
