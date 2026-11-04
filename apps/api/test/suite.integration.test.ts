import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { harness, password, responseCookie } from "./suite-harness.js";
import { ImonMeetsClient } from "../../../packages/sdk/index.js";
const options = { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 };
function totp(uri: string) {
  const secret = new URL(uri).searchParams.get("secret")!,
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.toUpperCase().replaceAll("=", "")]
    .map((v) => alphabet.indexOf(v).toString(2).padStart(5, "0"))
    .join("");
  const bytes = Buffer.from(
      (bits.match(/.{8}/g) ?? []).map((v) => Number.parseInt(v, 2)),
    ),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", bytes).update(counter).digest(),
    offset = mac[mac.length - 1]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
test(
  "waiting room, real SDK, persistent chat, tenant isolation and revoked generations",
  options,
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("owner-suite@example.com"),
        other = await h.signup("other-suite@example.com"),
        member = await h.signup("member-suite@example.com"),
        w = await h.workspace(owner.cookie),
        w2 = await h.workspace(other.cookie),
        room = await h.room(owner.cookie, w.id),
        otherRoom = await h.room(other.cookie, w2.id, { waitingRoom: false });
      assert.equal(room.waitingRoom, true);
      const sdk = new ImonMeetsClient({
        baseUrl: "http://localhost/api",
        fetch: (async (input, init) => {
          const url = new URL(String(input)),
            headers: Record<string, string> = {};
          new Headers(init?.headers).forEach((v, k) => {
            headers[k] = v;
          });
          const r = await h.request(
            init?.method as "GET" | "POST" | "DELETE",
            url.pathname + url.search,
            init?.body ? JSON.parse(String(init.body)) : undefined,
            undefined,
            headers,
          );
          return new Response(r.body, {
            status: r.statusCode,
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });
      assert.equal((await sdk.getRoom(room.slug)).room.waitingRoom, true);
      const queued = await sdk.join(room.slug, { name: "Гость" });
      assert.equal(queued.status, "waiting");
      if (queued.status !== "waiting") throw new Error("Missing waiting grant");
      assert.equal("token" in queued, false);
      assert.equal("chatToken" in queued, false);
      assert.equal(
        (await sdk.waitingStatus(room.slug, queued.waitingToken)).status,
        "waiting",
      );
      assert.equal(
        (
          await h.request("POST", `/api/rooms/${otherRoom.slug}/join`, {
            name: "Impersonator",
            waitingToken: queued.waitingToken,
          })
        ).statusCode,
        403,
      ); // Supplying a ticket never bypasses its room binding.
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/rooms/${otherRoom.slug}/waiting-status`,
            { waitingToken: queued.waitingToken },
          )
        ).statusCode,
        404,
      );
      const forbidden = await h.request(
        "PATCH",
        `/api/workspaces/${w.id}/rooms/${room.id}/waiting/${queued.requestId}`,
        { decision: "admitted" },
        other.cookie,
      );
      assert.equal(forbidden.statusCode, 404);
      assert.equal(
        (await h.request("GET", `/api/rooms/${room.slug}/chat`)).statusCode,
        401,
      );
      const queue = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/rooms/${room.id}/waiting`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(queue.requests.length, 1);
      assert.equal(queue.requests[0].name, "Гость");
      assert.equal(JSON.stringify(queue).includes(queued.waitingToken), false);
      assert.equal(
        (
          await h.request(
            "PATCH",
            `/api/workspaces/${w.id}/rooms/${room.id}/waiting/${queued.requestId}`,
            { decision: "admitted" },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (await sdk.waitingStatus(room.slug, queued.waitingToken)).status,
        "admitted",
      );
      const joined = await sdk.join(room.slug, {
        name: "Changed after approval",
        waitingToken: queued.waitingToken,
      });
      assert.equal(joined.status, "joined");
      if (joined.status !== "joined") throw new Error("Missing token");
      assert.equal(
        (
          await h.request("POST", `/api/rooms/${room.slug}/join`, {
            name: "Replay",
            waitingToken: queued.waitingToken,
          })
        ).statusCode,
        410,
      );
      const clientId = randomUUID(),
        sent = await sdk.sendMessage(room.slug, joined.chatToken, {
          text: "Сохраненное сообщение",
          clientId,
        });
      assert.equal(sent.message.name, "Гость");
      assert.equal(
        (
          await sdk.sendMessage(room.slug, joined.chatToken, {
            text: "Duplicate with different body",
            clientId,
          })
        ).message.id,
        sent.message.id,
      );
      assert.equal(
        (await sdk.readMessages(room.slug, joined.chatToken)).messages.length,
        1,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${otherRoom.slug}/chat`,
            undefined,
            undefined,
            { "x-imon-room-session": joined.chatToken },
          )
        ).statusCode,
        403,
      );
      const ownJoin = (
        await h.request(
          "POST",
          `/api/rooms/${room.slug}/join`,
          {},
          owner.cookie,
        )
      ).json();
      assert.equal(ownJoin.status, "joined");
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat`,
            undefined,
            undefined,
            { "x-imon-room-session": ownJoin.chatToken },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat?after=${sent.message.id}`,
            undefined,
            owner.cookie,
            { "x-imon-room-session": ownJoin.chatToken },
          )
        ).json().messages.length,
        0,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/rooms/${room.id}/chat`,
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      // Recent and older history have independent, validated cursors.
      await h.pool.query(
        "INSERT INTO im_messages(room_id,identity,name,client_id,text) SELECT $1,'imported','History',gen_random_uuid(),'m'||n FROM generate_series(1,105) n",
        [room.id],
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/rooms/${room.id}/chat?before=9999999999999999999`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      const latest = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/rooms/${room.id}/chat`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(latest.messages.length, 100);
      assert.equal(latest.hasEarlier, true);
      const older = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/rooms/${room.id}/chat?before=${latest.messages[0].id}`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(older.messages.length, 6);
      const denied = await sdk.join(room.slug, { name: "Denied" });
      assert.equal(denied.status, "waiting");
      if (denied.status !== "waiting") throw new Error("Expected waiting");
      await h.request(
        "PATCH",
        `/api/workspaces/${w.id}/rooms/${room.id}/waiting/${denied.requestId}`,
        { decision: "denied" },
        owner.cookie,
      );
      assert.equal(
        (await sdk.waitingStatus(room.slug, denied.waitingToken)).status,
        "denied",
      );
      assert.equal(
        (
          await h.request("POST", `/api/rooms/${room.slug}/join`, {
            name: "Denied",
            waitingToken: denied.waitingToken,
          })
        ).statusCode,
        403,
      );
      // Rotation must retire the media name, invalidate chat grants, and reset pending admission tickets.
      const rotation = await h.request(
        "POST",
        `/api/workspaces/${w.id}/rooms/${room.id}/rotate-link`,
        {},
        owner.cookie,
      );
      assert.equal(rotation.statusCode, 200, rotation.body);
      assert.equal(rotation.json().accessReset, true);
      assert.ok(h.retired.includes(room.id));
      const rotated = rotation.json().room;
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat`,
            undefined,
            undefined,
            { "x-imon-room-session": joined.chatToken },
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${rotated.slug}/chat`,
            undefined,
            undefined,
            { "x-imon-room-session": joined.chatToken },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await sdk.waitingStatus(rotated.slug, denied.waitingToken)).status,
        "expired",
      );
      const afterRotation = await h.request(
        "POST",
        `/api/rooms/${rotated.slug}/join`,
        {},
        owner.cookie,
      );
      assert.equal(afterRotation.json().roomName, `${room.id}-g1`);
      const closed = await h.request(
        "POST",
        `/api/workspaces/${w.id}/rooms/${room.id}/close`,
        {},
        owner.cookie,
      );
      assert.equal(closed.statusCode, 200, closed.body);
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/rooms/${rotated.slug}/chat`,
            { text: "after close", clientId: randomUUID() },
            owner.cookie,
            { "x-imon-room-session": afterRotation.json().chatToken },
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/rooms/${room.id}/chat`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      // A non-manager member must wait too, and removal revokes their member-bound chat session.
      await h.pool.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), w.id, member.id],
      );
      const open = await h.room(owner.cookie, w.id, { waitingRoom: false }),
        memberJoin = (
          await h.request(
            "POST",
            `/api/rooms/${open.slug}/join`,
            {},
            member.cookie,
          )
        ).json();
      const memberId = (
        await h.pool.query(
          "SELECT id FROM im_members WHERE workspace_id=$1 AND user_id=$2",
          [w.id, member.id],
        )
      ).rows[0].id;
      const removed = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}/members/${memberId}`,
        undefined,
        owner.cookie,
      );
      assert.equal(removed.statusCode, 200, removed.body);
      const newSlug = (
        await h.pool.query("SELECT slug FROM im_rooms WHERE id=$1", [open.id])
      ).rows[0].slug;
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${newSlug}/chat`,
            undefined,
            member.cookie,
            { "x-imon-room-session": memberJoin.chatToken },
          )
        ).statusCode,
        403,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "authenticator enrollment verifies code, invalidates older sessions, challenges login, and consumes backup code once",
  options,
  async () => {
    const h = await harness();
    try {
      const account = await h.signup("mfa-suite@example.com");
      let cookie = account.cookie;
      const oldLogin = await h.request("POST", "/api/auth/sign-in/email", {
          email: account.email,
          password,
        }),
        oldCookie = responseCookie(oldLogin);
      const enable = await h.request(
        "POST",
        "/api/auth/two-factor/enable",
        { password, method: "totp" },
        cookie,
      );
      assert.equal(enable.statusCode, 200, enable.body);
      const setup = enable.json();
      assert.equal(setup.method, "totp");
      assert.equal(setup.backupCodes.length, 10);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, cookie)).json().user
          .twoFactorEnabled,
        false,
      );
      const verified = await h.request(
        "POST",
        "/api/auth/two-factor/verify-totp",
        { code: totp(setup.totpURI), trustDevice: false },
        cookie,
      );
      assert.equal(verified.statusCode, 200, verified.body);
      cookie = responseCookie(verified, cookie);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, cookie)).json().user
          .twoFactorEnabled,
        true,
      );
      assert.equal(
        (await h.request("GET", "/api/me", undefined, oldCookie)).statusCode,
        401,
      );
      const dbFactor = (
        await h.pool.query(
          'SELECT secret,"backupCodes" FROM "twoFactor" WHERE "userId"=$1',
          [account.id],
        )
      ).rows[0];
      assert.equal(dbFactor.backupCodes.includes(setup.backupCodes[0]), false);
      assert.equal(
        dbFactor.secret.includes(
          new URL(setup.totpURI).searchParams.get("secret"),
        ),
        false,
      );
      await h.request("POST", "/api/auth/sign-out", {}, cookie);
      const challenge = await h.request("POST", "/api/auth/sign-in/email", {
        email: account.email,
        password,
      });
      assert.equal(challenge.statusCode, 200, challenge.body);
      assert.equal(challenge.json().twoFactorRedirect, true);
      const challengeCookie = responseCookie(challenge);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, challengeCookie))
          .statusCode,
        401,
      );
      const bad = await h.request(
        "POST",
        "/api/auth/two-factor/verify-totp",
        { code: "99999999", trustDevice: false },
        challengeCookie,
      );
      assert.ok([400, 401].includes(bad.statusCode));
      const recovery = await h.request(
        "POST",
        "/api/auth/two-factor/verify-backup-code",
        { code: setup.backupCodes[0], trustDevice: false },
        challengeCookie,
      );
      assert.equal(recovery.statusCode, 200, recovery.body);
      cookie = responseCookie(recovery, challengeCookie);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, cookie)).statusCode,
        200,
      );
      const challenge2 = await h.request("POST", "/api/auth/sign-in/email", {
          email: account.email,
          password,
        }),
        challengeCookie2 = responseCookie(challenge2);
      const replay = await h.request(
        "POST",
        "/api/auth/two-factor/verify-backup-code",
        { code: setup.backupCodes[0], trustDevice: false },
        challengeCookie2,
      );
      assert.equal(replay.statusCode, 401, replay.body);
      // A password change invalidates outstanding MFA challenges, not only complete sessions.
      const changed = await h.request(
        "POST",
        "/api/auth/change-password",
        {
          currentPassword: password,
          newPassword: "Changed-strong-suite-90123",
        },
        cookie,
      );
      assert.equal(changed.statusCode, 200, changed.body);
      const staleChallenge = await h.request(
        "POST",
        "/api/auth/two-factor/verify-backup-code",
        { code: setup.backupCodes[1], trustDevice: false },
        challengeCookie2,
      );
      assert.equal(staleChallenge.statusCode, 401, staleChallenge.body);
    } finally {
      await h.close();
    }
  },
);

test(
  "recording retention/deletion prevents downloads immediately and retries external cleanup; analysis is tenant scoped",
  options,
  async () => {
    const h = await harness({
      RECORDING_ENABLED: "true",
      S3_BUCKET: "test",
      S3_REGION: "test-1",
      S3_ACCESS_KEY_ID: "test",
      S3_SECRET_ACCESS_KEY: "test-only-secret",
    });
    try {
      const owner = await h.signup("records-suite@example.com"),
        other = await h.signup("records-other@example.com"),
        w = await h.workspace(owner.cookie),
        r = await h.room(owner.cookie, w.id);
      const id = randomUUID(),
        key = `recordings/${w.id}/${id}.mp4`,
        egressId = "EG_legacyManifestRetry";
      await h.pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key,egress_id,started_at,ended_at,expires_at,size_bytes) VALUES($1,$2,$3,'complete',$4,$5,now(),now(),now()+interval '1 day',4096)",
        [id, w.id, r.id, key, egressId],
      );
      assert.equal(
        (
          await h.request(
            "DELETE",
            `/api/workspaces/${w.id}/recordings/${id}`,
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/recordings/${id}/transcript`,
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/recordings/${id}/transcript`,
            { language: "ru", summary: false },
            owner.cookie,
          )
        ).statusCode,
        503,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/recordings/${id}/transcript`,
            undefined,
            owner.cookie,
          )
        ).json().job,
        null,
      );
      h.media.delete = async (k, persistedEgressId) => {
        assert.equal(k, key);
        assert.equal(persistedEgressId, egressId);
        h.deleted.push(k);
        throw new Error("Legacy manifest cleanup failed after MP4 deletion");
      };
      const pending = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}/recordings/${id}`,
        undefined,
        owner.cookie,
      );
      assert.equal(pending.statusCode, 200, pending.body);
      assert.equal(pending.json().deletionPending, true);
      const retryState = (
        await h.pool.query(
          "SELECT deleted_at,delete_attempts,delete_attempt_at FROM im_recordings WHERE id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(retryState.deleted_at, null);
      assert.equal(retryState.delete_attempts, 1);
      assert.ok(retryState.delete_attempt_at);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/recordings/${id}/download`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/recordings/${id}/transcript`,
            undefined,
            owner.cookie,
          )
        ).statusCode,
        404,
      );
      h.media.delete = async (k, persistedEgressId) => {
        assert.equal(persistedEgressId, egressId);
        h.deleted.push(k);
      };
      await h.pool.query(
        "UPDATE im_recordings SET delete_attempt_at=now() WHERE id=$1",
        [id],
      );
      const removed = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}/recordings/${id}`,
        undefined,
        owner.cookie,
      );
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(removed.json().deletionPending, false);
      assert.ok(h.deleted.includes(key));
      const list = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/recordings`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(list.recordings.length, 0);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${w.id}/overview`,
            undefined,
            owner.cookie,
          )
        ).json().recordingsCount,
        0,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "personal export omits credentials; ownership transfer, deletion and stale sessions enforce account lifecycle",
  options,
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("delete-owner@example.com"),
        member = await h.signup("delete-member@example.com"),
        w = await h.workspace(owner.cookie),
        r = await h.room(owner.cookie, w.id, { waitingRoom: false });
      const memberId = randomUUID();
      await h.pool.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
        [memberId, w.id, member.id],
      );
      const joined = (
        await h.request("POST", `/api/rooms/${r.slug}/join`, {}, owner.cookie)
      ).json();
      await h.request(
        "POST",
        `/api/rooms/${r.slug}/chat`,
        { text: "Мое сообщение", clientId: randomUUID() },
        owner.cookie,
        { "x-imon-room-session": joined.chatToken },
      );
      const exportResponse = await h.request(
        "GET",
        "/api/me/export",
        undefined,
        owner.cookie,
      );
      assert.equal(exportResponse.statusCode, 200, exportResponse.body);
      const data = exportResponse.json();
      assert.equal(data.profile.email, owner.email);
      assert.equal(data.messages.length, 1);
      assert.equal(JSON.stringify(data).includes(password), false);
      assert.equal("password" in data.profile, false);
      assert.equal("sessions" in data, false);
      const deleted = await h.request(
        "DELETE",
        "/api/me",
        { password, confirmation: "DELETE" },
        owner.cookie,
      );
      assert.equal(deleted.statusCode, 409);
      assert.equal(deleted.json().error.code, "OWNED_WORKSPACES");
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/transfer-ownership`,
            { memberId, password: "bad-password" },
            owner.cookie,
          )
        ).statusCode,
        403,
      );
      const transfer = await h.request(
        "POST",
        `/api/workspaces/${w.id}/transfer-ownership`,
        { memberId, password },
        owner.cookie,
      );
      assert.equal(transfer.statusCode, 200, transfer.body);
      const oneOwner = (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM im_members WHERE workspace_id=$1 AND role='owner'",
          [w.id],
        )
      ).rows[0].n;
      assert.equal(oneOwner, 1);
      const erased = await h.request(
        "DELETE",
        "/api/me",
        { password, confirmation: "DELETE" },
        owner.cookie,
      );
      assert.equal(erased.statusCode, 200, erased.body);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, owner.cookie)).statusCode,
        401,
      );
      assert.equal(
        (await h.pool.query('SELECT 1 FROM "user" WHERE id=$1', [owner.id]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await h.pool.query("SELECT 1 FROM im_messages WHERE user_id=$1", [
            owner.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await h.pool.query("SELECT created_by FROM im_rooms WHERE id=$1", [
            r.id,
          ])
        ).rows[0].created_by,
        member.id,
      );
      const workspaceDelete = await h.request(
        "DELETE",
        `/api/workspaces/${w.id}`,
        { password, confirmation: "DELETE" },
        member.cookie,
      );
      assert.equal(workspaceDelete.statusCode, 200, workspaceDelete.body);
      assert.equal(
        (await h.pool.query("SELECT 1 FROM im_workspaces WHERE id=$1", [w.id]))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await h.request(
            "DELETE",
            "/api/me",
            { password, confirmation: "DELETE" },
            member.cookie,
          )
        ).statusCode,
        200,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "account JSON export paginates complete personal data and client abort releases database resources",
  options,
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("stream-export@example.com"),
        other = await h.signup("stream-export-other@example.com"),
        w = await h.workspace(owner.cookie),
        room = await h.room(owner.cookie, w.id);
      await h.pool.query(
        "INSERT INTO im_messages(room_id,user_id,identity,name,client_id,text) SELECT $1,$2,'exporter','Export',gen_random_uuid(),repeat('a',1800)||n FROM generate_series(1,1105) n",
        [room.id, owner.id],
      );
      await h.pool.query(
        "INSERT INTO im_audit(workspace_id,actor_id,event,resource_id) SELECT $1,$2,'test.export','event-'||n FROM generate_series(1,1003) n",
        [w.id, owner.id],
      );
      await h.pool.query(
        "INSERT INTO im_messages(room_id,user_id,identity,name,client_id,text) VALUES($1,$2,'other','Other',gen_random_uuid(),'PRIVATE-OTHER-TEXT')",
        [room.id, other.id],
      );
      const result = await h.request(
        "GET",
        "/api/me/export",
        undefined,
        owner.cookie,
      );
      assert.equal(result.statusCode, 200, result.body.slice(0, 200));
      const exported = result.json();
      assert.equal(exported.messages.length, 1105);
      assert.equal(
        exported.events.filter(
          (e: { event: string }) => e.event === "test.export",
        ).length,
        1003,
      );
      assert.equal(
        new Set(exported.messages.map((m: { id: string }) => m.id)).size,
        1105,
      );
      assert.equal(result.body.includes("PRIVATE-OTHER-TEXT"), false);
      assert.equal(result.body.includes("cursor_id"), false);
      const address = await h.app.listen({ host: "127.0.0.1", port: 0 });
      const controller = new AbortController();
      const response = await fetch(`${address}/api/me/export`, {
        headers: { cookie: owner.cookie },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      assert.equal((await reader.read()).done, false);
      controller.abort();
      await reader.cancel().catch(() => {});
      // A canceled export must not retain a connection or continue its remaining pages.
      for (let attempt = 0; attempt < 30; attempt++) {
        if (h.pool.totalCount === h.pool.idleCount && h.pool.waitingCount === 0)
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(h.pool.waitingCount, 0);
      assert.equal(h.pool.totalCount, h.pool.idleCount);
      assert.equal(
        (await h.request("GET", "/api/me", undefined, owner.cookie)).statusCode,
        200,
      );
      // A creator who has left the workspace cannot export its subsequently edited private metadata.
      await h.pool.query(
        "UPDATE im_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",
        [w.id, owner.id],
      );
      await h.pool.query(
        "INSERT INTO im_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'owner')",
        [randomUUID(), w.id, other.id],
      );
      await h.pool.query(
        "DELETE FROM im_members WHERE workspace_id=$1 AND user_id=$2",
        [w.id, owner.id],
      );
      await h.pool.query(
        "UPDATE im_rooms SET description='PRIVATE-AFTER-REMOVAL' WHERE id=$1",
        [room.id],
      );
      const restricted = await h.request(
        "GET",
        "/api/me/export",
        undefined,
        owner.cookie,
      );
      assert.equal(restricted.statusCode, 200);
      assert.equal(restricted.json().createdRooms.length, 0);
      assert.equal(restricted.body.includes("PRIVATE-AFTER-REMOVAL"), false);
    } finally {
      await h.close();
    }
  },
);
