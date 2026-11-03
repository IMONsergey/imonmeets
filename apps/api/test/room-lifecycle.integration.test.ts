import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness, responseCookie } from "./suite-harness.js";
const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };

test(
  "only open rooms consume quota; closed-room archive preserves history and pages are bounded and scoped",
  dbTest,
  async () => {
    const h = await harness({
      BILLING_MODE: "commercial",
      BILLING_FREE_ROOMS: "2",
    });
    try {
      const owner = await h.signup("quota-owner@example.test"),
        outsider = await h.signup("quota-outsider@example.test");
      const w = await h.workspace(owner.cookie),
        other = await h.workspace(outsider.cookie);
      const r1 = await h.room(owner.cookie, w.id, { waitingRoom: false }),
        r2 = await h.room(owner.cookie, w.id);
      const create = () =>
        h.request(
          "POST",
          `/api/workspaces/${w.id}/rooms`,
          { title: "Next" },
          owner.cookie,
        );
      assert.equal((await create()).statusCode, 409);
      const grant = (
        await h.request("POST", `/api/rooms/${r1.slug}/join`, {}, owner.cookie)
      ).json();
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/rooms/${r1.slug}/chat`,
            { text: "Preserved history", clientId: randomUUID() },
            owner.cookie,
            { "x-imon-room-session": grant.chatToken },
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/rooms/${r1.id}/archive`,
            {},
            owner.cookie,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/rooms/${r1.id}/close`,
            {},
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      const concurrent = await Promise.all([create(), create()]);
      assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
      const plan = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/plan`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.equal(plan.roomsQuotaBasis, "open");
      assert.equal(plan.usage.rooms, 2);
      const archive = await h.request(
        "POST",
        `/api/workspaces/${w.id}/rooms/${r1.id}/archive`,
        {},
        owner.cookie,
      );
      assert.equal(archive.statusCode, 200, archive.body);
      assert.ok(archive.json().room.archivedAt);
      assert.equal(
        (await h.request("GET", `/api/rooms/${r1.slug}`)).statusCode,
        404,
      );
      const history = await h.request(
        "GET",
        `/api/workspaces/${w.id}/rooms/${r1.id}/chat`,
        undefined,
        owner.cookie,
      );
      assert.equal(history.statusCode, 200);
      assert.equal(history.json().messages[0].text, "Preserved history");
      const archived = (
        await h.request(
          "GET",
          `/api/workspaces/${w.id}/rooms?view=archived`,
          undefined,
          owner.cookie,
        )
      ).json();
      assert.deepEqual(
        archived.rooms.map((r: { id: string }) => r.id),
        [r1.id],
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${other.id}/rooms/${r1.id}/unarchive`,
            {},
            outsider.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "POST",
            `/api/workspaces/${w.id}/rooms/${r1.id}/unarchive`,
            {},
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal((await create()).statusCode, 409); // Unarchiving a closed room never opens it.
      await h.pool.query(
        "INSERT INTO im_rooms(id,workspace_id,slug,title,status,created_by) SELECT gen_random_uuid()::text,$1,gen_random_uuid()::text,'History '||n,'closed',$2 FROM generate_series(1,205) n",
        [w.id, owner.id],
      );
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        const page = await h.request(
          "GET",
          `/api/workspaces/${w.id}/rooms?view=closed&q=History${cursor ? "&before=" + cursor : ""}`,
          undefined,
          owner.cookie,
        );
        assert.equal(page.statusCode, 200, page.body);
        assert.ok(page.json().rooms.length <= 100);
        ids.push(...page.json().rooms.map((r: { id: string }) => r.id));
        cursor = page.json().nextCursor || undefined;
      } while (cursor);
      assert.equal(ids.length, 205);
      assert.equal(new Set(ids).size, 205);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/workspaces/${other.id}/rooms?before=${r2.id}`,
            undefined,
            outsider.cookie,
          )
        ).json().rooms.length,
        0,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_messages WHERE room_id=$1",
            [r1.id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await h.close();
    }
  },
);
