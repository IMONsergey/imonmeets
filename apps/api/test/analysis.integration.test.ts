import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { harness } from "./suite-harness.js";

test(
  "analysis cancels deleted or expired media independently of long jobs and requeues on graceful shutdown",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async (t) => {
    const requests = new Map<
      string,
      { closed: boolean; response: ServerResponse }
    >();
    const server = createServer((request, response) => {
      assert.equal(request.url, "/transcribe");
      assert.equal(
        request.headers.authorization,
        "Bearer synthetic-analysis-worker-secret-only",
      );
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const job = JSON.parse(Buffer.concat(chunks).toString());
        const entry = { closed: false, response };
        response.once("close", () => {
          entry.closed = true;
        });
        requests.set(job.jobId, entry);
        // Intentionally keep headers pending, as a real CPU job does.
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    // Advance only scheduler intervals; real network I/O and database timestamps
    // remain real. This covers periodic cleanup without five-second sleeps.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = await harness({
      RECORDING_ENABLED: "true",
      S3_BUCKET: "synthetic-analysis",
      S3_ACCESS_KEY_ID: "synthetic",
      S3_SECRET_ACCESS_KEY: "synthetic",
      S3_REGION: "us-east-1",
      TRANSCRIPTION_ENABLED: "true",
      ANALYSIS_WORKER_URL: "http://127.0.0.1:" + address.port,
      ANALYSIS_WORKER_SECRET: "synthetic-analysis-worker-secret-only",
      ANALYSIS_MODEL_MANIFEST_SHA256: "a".repeat(64),
    });
    async function until<T>(check: () => Promise<T> | T, message: string) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const value = await check();
        if (value) return value;
        t.mock.timers.tick(5000);
        await delay(5);
      }
      assert.fail(message);
    }
    try {
      const owner = await h.signup("analysis-lifecycle@example.test");
      const workspace = await h.workspace(owner.cookie);
      const room = await h.room(owner.cookie, workspace.id);
      async function recording() {
        const id = randomUUID();
        await h.pool.query(
          "INSERT INTO im_recordings(id,workspace_id,room_id,status,object_key,size_bytes,ended_at,expires_at) VALUES($1,$2,$3,'complete',$4,1024,now(),now()+interval '1 day')",
          [
            id,
            workspace.id,
            room.id,
            "recordings/" + workspace.id + "/" + id + ".mp4",
          ],
        );
        return id;
      }
      const path = (id: string) =>
        "/api/workspaces/" + workspace.id + "/recordings/" + id;
      async function start(id: string) {
        const response = await h.request(
          "POST",
          path(id) + "/transcript",
          { language: "ru", summary: false },
          owner.cookie,
        );
        assert.equal(response.statusCode, 200, response.body);
        const jobId = response.json().job.id as string;
        const request = await until(
          () => requests.get(jobId),
          "The queued job must reach the private worker",
        );
        const state = (
          await h.pool.query(
            "SELECT status,extract(epoch FROM (lease_until-now())) AS seconds FROM im_recording_analysis WHERE id=$1",
            [jobId],
          )
        ).rows[0];
        assert.equal(state.status, "running");
        assert.ok(Number(state.seconds) > 0 && Number(state.seconds) <= 121);
        return { jobId, request };
      }

      const deleted = await recording();
      const first = await start(deleted);
      const removal = await h.request(
        "DELETE",
        path(deleted) + "/transcript",
        undefined,
        owner.cookie,
      );
      assert.equal(removal.statusCode, 200, removal.body);
      await until(
        () => first.request.closed,
        "Deleting analysis must close its worker connection",
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT id FROM im_recording_analysis WHERE id=$1",
            [first.jobId],
          )
        ).rowCount,
        0,
      );

      const source = await recording();
      const second = await start(source);
      const sourceRemoval = await h.request(
        "DELETE",
        path(source),
        undefined,
        owner.cookie,
      );
      assert.equal(sourceRemoval.statusCode, 200, sourceRemoval.body);
      await until(
        () => second.request.closed,
        "Source deletion must cancel processing through the independent sweep",
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT id FROM im_recording_analysis WHERE id=$1",
            [second.jobId],
          )
        ).rowCount,
        0,
      );

      const expiring = await recording();
      const third = await start(expiring);
      const oldRecording = await recording();
      await h.pool.query(
        "INSERT INTO im_recording_analysis(recording_id,workspace_id,id,status,language,expires_at) VALUES($1,$2,$3,'complete','ru',now()-interval '1 second')",
        [oldRecording, workspace.id, randomUUID()],
      );
      await h.pool.query(
        "UPDATE im_recordings SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expiring],
      );
      await until(
        () => third.request.closed,
        "Source expiry must cancel a long job",
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT id FROM im_recording_analysis WHERE recording_id=ANY($1::text[])",
            [[oldRecording, expiring]],
          )
        ).rowCount,
        0,
        "Unrelated expired analysis must be deleted while the worker is busy",
      );

      const restart = await recording();
      const fourth = await start(restart);
      await h.app.close();
      await until(
        () => fourth.request.closed,
        "Graceful shutdown must close the worker connection",
      );
      const state = (
        await h.pool.query(
          "SELECT status,attempts,lease_id,lease_until,error FROM im_recording_analysis WHERE id=$1",
          [fourth.jobId],
        )
      ).rows[0];
      assert.deepEqual(state, {
        status: "queued",
        attempts: 0,
        lease_id: null,
        lease_until: null,
        error: null,
      });
    } finally {
      await h.close();
    }
  },
);
