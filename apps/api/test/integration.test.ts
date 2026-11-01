import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  AccessToken,
  EgressInfo,
  EgressStatus,
  EncodedFileOutput,
} from "livekit-server-sdk";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { schema } from "../src/db.js";
import { createMedia } from "../src/media.js";

// Every run uses an isolated PostgreSQL schema, dropped in finally. Never clears a shared schema.
test(
  "real PostgreSQL auth, tenant isolation, invitation ownership/replay and room policy",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async () => {
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      ns = `im_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${ns}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("options", `-csearch_path=${ns}`);
    const config = loadConfig({
        DATABASE_URL: url.toString(),
        DEV_ALLOW_UNVERIFIED_EMAIL: "true",
        APP_URL: "http://localhost:5173",
        LIVEKIT_URL: "ws://localhost:7880",
        LIVEKIT_API_KEY: "integration-key",
        LIVEKIT_API_SECRET: "integration-secret-at-least-32-characters",
      }),
      pool = new Pool({ connectionString: url.toString() });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const auth = createAuth(config, pool);
      await (await getMigrations(auth.options)).runMigrations();
      await pool.query(schema);
      const media = createMedia(config);
      media.rooms.createRoom = async () =>
        ({}) as Awaited<ReturnType<typeof media.rooms.createRoom>>;
      media.rooms.deleteRoom = async () => {};
      app = await createApp(config, { pool, logger: false, media });
      const api = app;
      async function request(
        method: "GET" | "POST" | "DELETE" | "PATCH",
        path: string,
        body?: unknown,
        cookie?: string,
        origin = config.appUrl,
      ) {
        return api.inject({
          method,
          url: path,
          headers: { origin, ...(cookie ? { cookie } : {}) },
          ...(body ? { payload: body as object } : {}),
        });
      }
      async function signup(email: string) {
        const r = await request("POST", "/api/auth/sign-up/email", {
          email,
          name: email.split("@")[0],
          password: "Strong-test-password-009",
        });
        assert.equal(r.statusCode, 200, r.body);
        const cookies = r.headers["set-cookie"];
        const cookie = (Array.isArray(cookies) ? cookies : [cookies])
          .filter(Boolean)
          .map((v) => v!.split(";")[0])
          .join("; ");
        assert.ok(cookie);
        return cookie;
      }
      const owner = await signup("owner@example.com"),
        other = await signup("other@example.com"),
        member = await signup("member@example.com");
      const me = await request("GET", "/api/me", undefined, owner);
      assert.equal(me.statusCode, 200);
      const ownerId = me.json().user.id;
      assert.equal(
        (
          await request(
            "POST",
            "/api/workspaces",
            { name: "Rejected" },
            owner,
            "https://evil.example",
          )
        ).statusCode,
        403,
      );
      const w = (
        await request("POST", "/api/workspaces", { name: "Team A" }, owner)
      ).json().workspace;
      assert.equal(w.role, "owner");
      const w2 = (
        await request("POST", "/api/workspaces", { name: "Team B" }, other)
      ).json().workspace;
      assert.equal(
        (
          await request(
            "GET",
            `/api/workspaces/${w.id}/rooms`,
            undefined,
            other,
          )
        ).statusCode,
        404,
      );
      const roomResponse = await request(
        "POST",
        `/api/workspaces/${w.id}/rooms`,
        { title: "Private", allowGuests: false },
        owner,
      );
      assert.equal(roomResponse.statusCode, 200, roomResponse.body);
      const room = roomResponse.json().room;
      assert.equal(
        (await request("GET", `/api/rooms/${room.slug}`)).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            "PATCH",
            `/api/workspaces/${w2.id}/rooms/${room.id}`,
            { title: "cross tenant" },
            other,
          )
        ).statusCode,
        404,
      );
      const invitationResponse = await request(
        "POST",
        `/api/workspaces/${w.id}/invitations`,
        { email: "member@example.com", role: "member" },
        owner,
      );
      assert.equal(invitationResponse.statusCode, 200, invitationResponse.body);
      const token = invitationResponse.json().inviteUrl.split("#token=")[1];
      assert.equal(
        (await request("POST", "/api/invitations/accept", { token }, member))
          .statusCode,
        403,
      );
      await pool.query(
        'UPDATE "user" SET "emailVerified"=true WHERE email IN ($1,$2)',
        ["member@example.com", "other@example.com"],
      );
      assert.equal(
        (await request("POST", "/api/invitations/accept", { token }, other))
          .statusCode,
        403,
      );
      const accepted = await request(
        "POST",
        "/api/invitations/accept",
        { token },
        member,
      );
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(
        (await request("POST", "/api/invitations/accept", { token }, member))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/api/workspaces/${w.id}/invitations`,
            { email: "third@example.com", role: "admin" },
            member,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            "PATCH",
            `/api/workspaces/${w.id}/rooms/${room.id}`,
            { title: "Forbidden" },
            member,
          )
        ).statusCode,
        403,
      );
      const roster = (
        await request(
          "GET",
          `/api/workspaces/${w.id}/members`,
          undefined,
          owner,
        )
      ).json();
      const ownerMember = roster.members.find(
        (m: { userId: string }) => m.userId === ownerId,
      );
      assert.equal(
        (
          await request(
            "DELETE",
            `/api/workspaces/${w.id}/members/${ownerMember.id}`,
            undefined,
            owner,
          )
        ).statusCode,
        403,
      );
      const rotated = (
        await request(
          "POST",
          `/api/workspaces/${w.id}/rooms/${room.id}/rotate-link`,
          {},
          owner,
        )
      ).json().room;
      assert.notEqual(rotated.slug, room.slug);
      assert.equal(
        (await request("GET", `/api/rooms/${room.slug}`, undefined, owner))
          .statusCode,
        404,
      );
      const closed = await request(
        "POST",
        `/api/workspaces/${w.id}/rooms/${room.id}/close`,
        {},
        owner,
      );
      assert.equal(closed.json().room.status, "closed");
      assert.equal(
        (await request("POST", `/api/rooms/${rotated.slug}/join`, {}, owner))
          .statusCode,
        409,
      );
      assert.equal(
        (
          await request(
            "POST",
            `/api/workspaces/${w.id}/rooms/${room.id}/recordings`,
            {},
            owner,
          )
        ).statusCode,
        503,
      );
      assert.equal(
        (
          await request("POST", "/api/livekit/webhook", {
            event: "egress_ended",
          })
        ).statusCode,
        401,
      );
      const guestRoom = (
        await request(
          "POST",
          `/api/workspaces/${w.id}/rooms`,
          { title: "Guest room", allowGuests: true },
          owner,
        )
      ).json().room;
      assert.equal(
        (await request("POST", `/api/rooms/${guestRoom.slug}/join`, {}))
          .statusCode,
        400,
      );
      const joined = await request(
        "POST",
        `/api/rooms/${guestRoom.slug}/join`,
        { name: "Guest" },
      );
      assert.equal(joined.statusCode, 200, joined.body);
      const joinedData = joined.json();
      assert.equal(joinedData.canManage, false);
      assert.equal(joinedData.workspaceId, undefined);
      const claims = JSON.parse(
        Buffer.from(joinedData.token.split(".")[1], "base64url").toString(),
      );
      assert.equal(claims.exp - claims.nbf, 300);
      assert.equal(claims.video.room, guestRoom.id);
      assert.equal(claims.video.roomJoin, true);
      assert.equal(claims.video.roomCreate, undefined);
      assert.equal(claims.video.roomAdmin, undefined);
      // Ten simultaneous authenticated joins previously exhausted the shared ten-client pool.
      const concurrent = await Promise.all(
        Array.from({ length: 10 }, () =>
          request("POST", `/api/rooms/${guestRoom.slug}/join`, {}, owner),
        ),
      );
      assert.ok(
        concurrent.every((response) => response.statusCode === 200),
        concurrent.map((r) => r.body).join("\n"),
      );
      assert.equal((await request("GET", "/api/health")).statusCode, 200);
      async function signedWebhook(info: EgressInfo, eventId = randomUUID()) {
        const raw =
          JSON.stringify(
            { id: eventId, event: "egress_updated", egressInfo: info.toJson() },
            null,
            2,
          ) + "\n";
        const signer = new AccessToken(
          config.livekit.apiKey,
          config.livekit.apiSecret,
          { ttl: 60 },
        );
        signer.sha256 = createHash("sha256").update(raw).digest("base64");
        return api.inject({
          method: "POST",
          url: "/api/livekit/webhook",
          payload: raw,
          headers: {
            "content-type": "application/webhook+json",
            authorization: await signer.toJwt(),
          },
        });
      }
      const rec1 = randomUUID(),
        key1 = `recordings/${w.id}/${rec1}.mp4`,
        rec2 = randomUUID(),
        key2 = `recordings/${w.id}/${rec2}.mp4`;
      await pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,egress_id,status,object_key) VALUES($1,$2,$3,'old-job','complete',$4)",
        [rec1, w.id, guestRoom.id, key1],
      );
      await pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key) VALUES($1,$2,$3,'starting',$4)",
        [rec2, w.id, guestRoom.id, key2],
      );
      const old = new EgressInfo({
        egressId: "old-job",
        roomName: guestRoom.id,
        status: EgressStatus.EGRESS_COMPLETE,
        fileResults: [{ filename: key1, size: 10n }],
      });
      assert.equal((await signedWebhook(old)).statusCode, 200);
      assert.equal(
        (
          await pool.query("SELECT egress_id FROM im_recordings WHERE id=$1", [
            rec2,
          ])
        ).rows[0].egress_id,
        null,
      );
      const current = new EgressInfo({
        egressId: "new-job",
        roomName: guestRoom.id,
        status: EgressStatus.EGRESS_ACTIVE,
        request: {
          case: "roomComposite",
          value: { fileOutputs: [new EncodedFileOutput({ filepath: key2 })] },
        },
      });
      const currentEventId = randomUUID();
      assert.equal(
        (await signedWebhook(current, currentEventId)).statusCode,
        200,
      );
      assert.equal(
        (await signedWebhook(current, currentEventId)).statusCode,
        200,
      );
      await pool.query("UPDATE im_recordings SET status='ending' WHERE id=$1", [
        rec2,
      ]);
      assert.equal((await signedWebhook(current)).statusCode, 200);
      assert.equal(
        (
          await pool.query("SELECT status FROM im_recordings WHERE id=$1", [
            rec2,
          ])
        ).rows[0].status,
        "ending",
      );
      current.status = EgressStatus.EGRESS_COMPLETE;
      current.fileResults = new EgressInfo({
        fileResults: [{ filename: key2, size: 500n }],
      }).fileResults;
      assert.equal((await signedWebhook(current)).statusCode, 200);
      assert.equal(
        (
          await pool.query("SELECT status FROM im_recordings WHERE id=$1", [
            rec2,
          ])
        ).rows[0].status,
        "complete",
      );
      const memberRoom = (
        await request(
          "POST",
          `/api/workspaces/${w.id}/rooms`,
          { title: "Member-created room" },
          member,
        )
      ).json().room;
      const memberRecordingId = randomUUID();
      await pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key) VALUES($1,$2,$3,'complete',$4)",
        [
          memberRecordingId,
          w.id,
          memberRoom.id,
          `recordings/${memberRecordingId}.mp4`,
        ],
      );
      const ownerRecordings = (
        await request(
          "GET",
          `/api/workspaces/${w.id}/recordings`,
          undefined,
          owner,
        )
      ).json().recordings;
      assert.ok(
        ownerRecordings.every((r: { canManage: boolean }) => r.canManage),
      );
      const memberRecordings = (
        await request(
          "GET",
          `/api/workspaces/${w.id}/recordings`,
          undefined,
          member,
        )
      ).json().recordings;
      assert.equal(
        memberRecordings.find((r: { id: string }) => r.id === memberRecordingId)
          .canManage,
        true,
      );
      const nonCreatorRecording = memberRecordings.find(
        (r: { id: string }) => r.id === rec2,
      );
      assert.equal(nonCreatorRecording.canManage, false);
      assert.equal(nonCreatorRecording.object_key, undefined);
      assert.equal(nonCreatorRecording.egress_id, undefined);
      assert.equal(
        (await request("POST", "/api/auth/sign-out", {}, owner)).statusCode,
        200,
      );
      assert.equal(
        (await request("GET", "/api/me", undefined, owner)).statusCode,
        401,
      );
    } finally {
      if (app) await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${ns}" CASCADE`);
      await admin.end();
    }
  },
);
