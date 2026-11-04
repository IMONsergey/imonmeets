import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness } from "./suite-harness.js";

const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };

for (const mode of ["pilot", "commercial"] as const) {
  test(
    `closed rooms release quota without losing history or admitting concurrent excess rooms (${mode})`,
    dbTest,
    async () => {
      const h = await harness({
        BILLING_MODE: mode,
        BILLING_FREE_ROOMS: "2",
        MAX_ROOMS_PER_WORKSPACE: "2",
      });
      try {
        const owner = await h.signup(`quota-${mode}-owner@example.test`);
        const outsider = await h.signup(`quota-${mode}-outsider@example.test`);
        const workspace = await h.workspace(owner.cookie);
        const otherWorkspace = await h.workspace(outsider.cookie);
        const first = await h.room(owner.cookie, workspace.id, {
          waitingRoom: false,
        });
        await h.room(owner.cookie, workspace.id);
        await h.room(outsider.cookie, otherWorkspace.id);

        const create = () =>
          h.request(
            "POST",
            `/api/workspaces/${workspace.id}/rooms`,
            { title: "Next meeting" },
            owner.cookie,
          );
        const close = (cookie = owner.cookie) =>
          h.request(
            "POST",
            `/api/workspaces/${workspace.id}/rooms/${first.id}/close`,
            {},
            cookie,
          );
        const plan = async () => {
          const response = await h.request(
            "GET",
            `/api/workspaces/${workspace.id}/plan`,
            undefined,
            owner.cookie,
          );
          assert.equal(response.statusCode, 200, response.body);
          return response.json();
        };

        const blocked = await create();
        assert.equal(blocked.statusCode, 409, blocked.body);
        assert.equal(blocked.json().error.code, "ROOM_LIMIT");
        assert.equal((await plan()).usage.rooms, 2);
        assert.equal((await close(outsider.cookie)).statusCode, 404);
        assert.equal((await plan()).usage.rooms, 2);

        const grant = await h.request(
          "POST",
          `/api/rooms/${first.slug}/join`,
          {},
          owner.cookie,
        );
        assert.equal(grant.statusCode, 200, grant.body);
        const message = await h.request(
          "POST",
          `/api/rooms/${first.slug}/chat`,
          { text: "History survives closing", clientId: randomUUID() },
          owner.cookie,
          { "x-imon-room-session": grant.json().chatToken },
        );
        assert.equal(message.statusCode, 200, message.body);
        const closed = await close();
        assert.equal(closed.statusCode, 200, closed.body);

        const afterClose = await plan();
        assert.equal(
          afterClose.usage.rooms,
          1,
          "a closed room must release one slot in both enforcement and the displayed usage",
        );
        assert.equal(afterClose.roomsQuotaBasis, "open");

        const concurrent = await Promise.all([create(), create()]);
        assert.deepEqual(
          concurrent.map((response) => response.statusCode).sort(),
          [200, 409],
          "the workspace lock must allow only the single released slot",
        );
        assert.equal((await plan()).usage.rooms, 2);
        assert.equal((await close()).statusCode, 200);
        assert.equal(
          (await create()).statusCode,
          409,
          "closing the same room again cannot release a second slot",
        );

        const rooms = await h.request(
          "GET",
          `/api/workspaces/${workspace.id}/rooms`,
          undefined,
          owner.cookie,
        );
        assert.equal(rooms.statusCode, 200, rooms.body);
        assert.equal(rooms.json().rooms.length, 3);
        assert.equal(
          rooms
            .json()
            .rooms.find((room: { id: string }) => room.id === first.id)?.status,
          "closed",
        );
        const history = await h.request(
          "GET",
          `/api/workspaces/${workspace.id}/rooms/${first.id}/chat`,
          undefined,
          owner.cookie,
        );
        assert.equal(history.statusCode, 200, history.body);
        assert.equal(
          history.json().messages[0]?.text,
          "History survives closing",
        );
        const otherPlan = await h.request(
          "GET",
          `/api/workspaces/${otherWorkspace.id}/plan`,
          undefined,
          outsider.cookie,
        );
        assert.equal(otherPlan.json().usage.rooms, 1);
      } finally {
        await h.close();
      }
    },
  );
}
