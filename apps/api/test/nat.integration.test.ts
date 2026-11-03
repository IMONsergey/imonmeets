import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { harness, responseCookie } from "./suite-harness.js";
const dbTest = { skip: !process.env.TEST_DATABASE_URL, timeout: 120_000 };

test(
  "one office NAT can join and poll 25 distinct room sessions; one abusive session is still limited",
  dbTest,
  async () => {
    const h = await harness();
    try {
      const owner = await h.signup("nat-owner@example.test"),
        w = await h.workspace(owner.cookie);
      const room = await h.room(owner.cookie, w.id, {
        waitingRoom: false,
        maxParticipants: 30,
      });
      const sessions: { token: string; cookie: string }[] = [];
      for (let index = 0; index < 25; index++) {
        const response = await h.request(
          "POST",
          `/api/rooms/${room.slug}/join`,
          { name: `Guest ${index}` },
        );
        assert.equal(response.statusCode, 200, response.body);
        sessions.push({
          token: response.json().chatToken,
          cookie: responseCookie(response),
        });
      }
      // All requests use the same socket IP, just like a shared office router.
      for (let round = 0; round < 20; round++) {
        const results = await Promise.all(
          sessions.map((s) =>
            h.request(
              "GET",
              `/api/rooms/${room.slug}/chat`,
              undefined,
              s.cookie,
              { "x-imon-room-session": s.token },
            ),
          ),
        );
        assert.ok(
          results.every((r) => r.statusCode === 200),
          results
            .filter((r) => r.statusCode !== 200)
            .map((r) => r.body)
            .join("\n"),
        );
      }
      let limited = false;
      for (let index = 0; index < 101; index++) {
        const r = await h.request(
          "GET",
          `/api/rooms/${room.slug}/chat`,
          undefined,
          sessions[0]!.cookie,
          { "x-imon-room-session": sessions[0]!.token },
        );
        if (r.statusCode === 429) {
          limited = true;
          assert.ok(Number(r.headers["retry-after"]) > 0);
          break;
        }
        assert.equal(r.statusCode, 200, r.body);
      }
      assert.equal(limited, true);
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat`,
            undefined,
            sessions[1]!.cookie,
            { "x-imon-room-session": sessions[1]!.token },
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await h.request(
            "GET",
            `/api/rooms/${room.slug}/chat`,
            undefined,
            undefined,
            { "x-imon-room-session": "x".repeat(43) },
          )
        ).statusCode,
        403,
      );
    } finally {
      await h.close();
    }
  },
);
