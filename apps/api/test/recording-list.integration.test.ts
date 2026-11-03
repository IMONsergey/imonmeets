import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness } from "./suite-harness.js";

test(
  "recording history is bounded, stable across equal timestamps and soft deletion, and tenant scoped",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 120000 },
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("recording-pages@example.test");
      const outsider = await h.signup("recording-pages-other@example.test");
      const w = await h.workspace(owner.cookie);
      const other = await h.workspace(outsider.cookie);
      const room = await h.room(owner.cookie, w.id);
      const otherRoom = await h.room(outsider.cookie, other.id);
      const ids = Array.from({ length: 205 }, () => randomUUID())
        .sort()
        .reverse();
      // All timestamps have identical microseconds: a cursor must retain the ID tiebreaker.
      await h.pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key,started_at) SELECT id,$2,$3,'complete','recordings/'||id||'.mp4','2026-11-03T00:00:00.123456Z' FROM unnest($1::text[]) id",
        [ids, w.id, room.id],
      );
      const foreignId = randomUUID();
      await h.pool.query(
        "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key) VALUES($1,$2,$3,'complete',$4)",
        [foreignId, other.id, otherRoom.id, "recordings/other-private.mp4"],
      );
      const path = `/api/workspaces/${w.id}/recordings`;
      const page = async (before?: string) => {
        const r = await h.request(
          "GET",
          path + (before ? "?before=" + before : ""),
          undefined,
          owner.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        return r.json() as {
          recordings: { id: string; canManage: boolean }[];
          nextCursor: string | null;
        };
      };
      const first = await page();
      assert.equal(
        first.recordings.length,
        100,
        "the first response must have a bounded row count",
      );
      assert.deepEqual(
        first.recordings.map((r) => r.id),
        ids.slice(0, 100),
      );
      assert.equal(first.nextCursor, ids[99]);
      assert(first.recordings.every((r) => r.canManage));
      assert(!JSON.stringify(first).includes("object_key"));
      assert(!JSON.stringify(first).includes(foreignId));
      // A deleted anchor remains usable; deletion must not strand the next 105 records.
      await h.pool.query(
        "UPDATE im_recordings SET deleted_at=now() WHERE id=$1",
        [first.nextCursor],
      );
      const second = await page(first.nextCursor!);
      assert.deepEqual(
        second.recordings.map((r) => r.id),
        ids.slice(100, 200),
      );
      assert.equal(second.nextCursor, ids[199]);
      const third = await page(second.nextCursor!);
      assert.deepEqual(
        third.recordings.map((r) => r.id),
        ids.slice(200),
      );
      assert.equal(third.nextCursor, null);
      assert.equal(
        new Set(
          [...first.recordings, ...second.recordings, ...third.recordings].map(
            (r) => r.id,
          ),
        ).size,
        205,
      );
      const foreignCursor = await page(foreignId);
      assert.deepEqual(foreignCursor.recordings, []);
      assert.equal(foreignCursor.nextCursor, null);
      const missingCursor = await page(randomUUID());
      assert.deepEqual(missingCursor.recordings, []);
      assert.equal(missingCursor.nextCursor, null);
      assert.equal(
        (await h.request("GET", path, undefined, outsider.cookie)).statusCode,
        404,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            path + "?before=not-a-recording",
            undefined,
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            path + "?limit=1000000",
            undefined,
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      const refreshed = await page();
      assert.equal(refreshed.recordings.length, 100);
      assert(!refreshed.recordings.some((r) => r.id === first.nextCursor));
      assert.equal(refreshed.nextCursor, ids[100]);
    } finally {
      await h.close();
    }
  },
);
