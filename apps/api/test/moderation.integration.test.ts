import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { AccessToken } from "livekit-server-sdk";
import { harness, responseCookie } from "./suite-harness.js";
const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };

const signalingSecret = "test-only-livekit-admission-secret-20261103";
test(
  "strict signaling gate, durable kick/ban, stale chat/tickets, account and anonymous reentry, role isolation and pending media retries",
  dbTest,
  async () => {
    const h = await harness({
      LIVEKIT_SIGNALING_AUTH_ENABLED: "true",
      LIVEKIT_SIGNALING_AUTH_SECRET: signalingSecret,
    });
    try {
      const owner = await h.signup("moderation-owner@example.test"),
        member = await h.signup("moderation-member@example.test"),
        other = await h.signup("moderation-other@example.test");
      const w = await h.workspace(owner.cookie);
      await h.pool.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), w.id, member.id],
      );
      const room = await h.room(owner.cookie, w.id, { waitingRoom: false });
      const join = (cookie?: string) =>
        h.request(
          "POST",
          `/api/rooms/${room.slug}/join`,
          { name: "Guest" },
          cookie,
        );
      const gate = (
        token?: string,
        secret = signalingSecret,
        extra: Record<string, string> = {},
      ) =>
        h.request(
          "GET",
          "/api/internal/livekit/authorize",
          undefined,
          undefined,
          {
            "x-imon-livekit-auth": secret,
            ...(token ? { authorization: "Bearer " + token } : {}),
            ...extra,
          },
        );
      const guestResponse = await join(),
        guest = guestResponse.json(),
        guestCookie = responseCookie(guestResponse);
      const twin = (await join(guestCookie)).json(),
        innocent = (await join()).json(),
        own = (await join(owner.cookie)).json(),
        mem = (await join(member.cookie)).json();
      assert.equal((await gate(guest.token)).statusCode, 204);
      assert.equal((await gate()).statusCode, 401);
      assert.equal((await gate(guest.token, "wrong")).statusCode, 403);
      assert.equal((await gate(guest.token + "broken")).statusCode, 401);
      assert.equal(
        (
          await gate(undefined, signalingSecret, {
            "x-imon-livekit-token": guest.token,
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (
          await gate(guest.token, signalingSecret, {
            "x-imon-livekit-token": innocent.token,
          })
        ).statusCode,
        401,
      );
      const forged = new AccessToken(
        h.c.livekit.apiKey,
        h.c.livekit.apiSecret,
        { identity: "guest:unregistered", ttl: 60 },
      );
      forged.addGrant({ roomJoin: true, room: room.id });
      assert.equal((await gate(await forged.toJwt())).statusCode, 403);
      const wrongIssuer = new AccessToken("other-key", h.c.livekit.apiSecret, {
        identity: guest.identity,
        ttl: 60,
      });
      wrongIssuer.addGrant({ roomJoin: true, room: room.id });
      assert.equal((await gate(await wrongIssuer.toJwt())).statusCode, 401);
      const removalCalls: string[] = [];
      let failRemoval = false;
      h.media.rooms.removeParticipant = async (_name, identity) => {
        if (failRemoval) throw new Error("isolated mock timeout");
        removalCalls.push(identity);
      };
      const remove = (identity: string, ban: boolean, cookie = owner.cookie) =>
        h.request(
          "POST",
          `/api/workspaces/${w.id}/rooms/${room.id}/participants/${encodeURIComponent(identity)}/remove`,
          { ban },
          cookie,
        );
      assert.equal(
        (await remove(guest.identity, true, member.cookie)).statusCode,
        403,
      );
      assert.equal((await remove(own.identity, true)).statusCode, 403);
      assert.equal(
        (await remove(guest.identity, true, other.cookie)).statusCode,
        404,
      );
      const banned = await remove(guest.identity, true);
      assert.equal(banned.statusCode, 200, banned.body);
      assert.equal(banned.json().guestAdmissionRequired, true);
      assert.ok(removalCalls.includes(guest.identity));
      assert.ok(removalCalls.includes(twin.identity));
      assert.equal(removalCalls.includes(innocent.identity), false);
      assert.equal(h.retired.length, 0); // Other participants remain in their original media room.
      assert.equal((await gate(guest.token)).statusCode, 403);
      assert.equal((await gate(twin.token)).statusCode, 403);
      assert.equal((await gate(innocent.token)).statusCode, 204);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat`,
            undefined,
            guestCookie,
            { "x-imon-room-session": guest.chatToken },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/rooms/${room.slug}/chat`,
            { text: "stale", clientId: randomUUID() },
            guestCookie,
            { "x-imon-room-session": guest.chatToken },
          )
        ).statusCode,
        403,
      );
      assert.equal((await join(guestCookie)).statusCode, 403);
      assert.equal((await join()).json().status, "waiting"); // Clearing cookies cannot silently bypass admission.
      const freshMember = await join(member.cookie);
      assert.equal(freshMember.statusCode, 200);
      assert.equal(freshMember.json().status, "joined");
      const banId = (
        await h.pool.query(
          "SELECT id FROM im_room_bans WHERE room_id=$1 AND identity=$2",
          [room.id, guest.identity],
        )
      ).rows[0].id;
      assert.equal(
        (
          await h.request(
            "DELETE",
            `/api/workspaces/${w.id}/rooms/${room.id}/blocked/${banId}`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal((await gate(guest.token)).statusCode, 403); // Unblock cannot resurrect revoked capabilities.
      const waitingAgain = (await join(guestCookie)).json();
      assert.equal(waitingAgain.status, "waiting");
      assert.equal(
        (
          await h.request(
            "PATCH",
            `/api/workspaces/${w.id}/rooms/${room.id}/waiting/${waitingAgain.requestId}`,
            { decision: "admitted" },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal((await remove(guest.identity, true)).statusCode, 200);
      // An already-admitted ticket, presented without the old browser cookie,
      // remains bound to its original blocked visitor and cannot mint a new JWT.
      assert.equal(
        (
          await h.request("POST", `/api/rooms/${room.slug}/join`, {
            name: "Retry",
            waitingToken: waitingAgain.waitingToken,
          })
        ).statusCode,
        403,
      );
      assert.equal((await remove(mem.identity, true)).statusCode, 200);
      assert.equal((await join(member.cookie)).statusCode, 403);
      assert.equal((await gate(freshMember.json().token)).statusCode, 403);
      // Workspace-wide historical access is an explicit product policy, unaffected by a live-room ban.
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/rooms/${room.id}/chat`,
            undefined,
            member.cookie,
          )
        ).statusCode,
        200,
      );
      failRemoval = true;
      const pending = await remove(innocent.identity, false);
      assert.equal(pending.statusCode, 503);
      assert.equal(pending.json().error.code, "PARTICIPANT_DISCONNECT_PENDING");
      assert.equal((await gate(innocent.token)).statusCode, 403);
      assert.equal((await gate(own.token)).statusCode, 204);
      assert.ok(
        (
          await h.pool.query(
            "SELECT 1 FROM im_participant_removals WHERE identity=$1",
            [innocent.identity],
          )
        ).rowCount,
      );
      failRemoval = false;
      assert.equal((await remove(innocent.identity, false)).statusCode, 200);
      assert.equal(
        (
          await h.pool.query(
            "SELECT 1 FROM im_participant_removals WHERE identity=$1",
            [innocent.identity],
          )
        ).rowCount,
        0,
      );
      // A pre-ban handshake may deliver participant_joined after removal. Signed
      // webhook replay must still enforce the current DB revocation, not revive it.
      const eventId = randomUUID();
      const raw = JSON.stringify({
        id: eventId,
        event: "participant_joined",
        room: { name: room.id },
        participant: { identity: guest.identity },
      });
      const signer = new AccessToken(
        h.c.livekit.apiKey,
        h.c.livekit.apiSecret,
        { ttl: 60 },
      );
      signer.sha256 = createHash("sha256").update(raw).digest("base64");
      const authorization = await signer.toJwt();
      const before = removalCalls.length;
      for (let i = 0; i < 2; i++) {
        const response = await h.app.inject({
          method: "POST",
          url: "/api/livekit/webhook",
          payload: raw,
          headers: {
            "content-type": "application/webhook+json",
            authorization,
          },
        });
        assert.equal(response.statusCode, 200, response.body);
      }
      assert.equal(removalCalls.length, before + 2);
      await h.request(
        "POST",
        `/api/workspaces/${w.id}/rooms/${room.id}/close`,
        {},
        owner.cookie,
      );
      assert.equal((await gate(own.token)).statusCode, 403);
      assert.equal((await gate(own.token)).body, "");
    } finally {
      await h.close();
    }
  },
);
