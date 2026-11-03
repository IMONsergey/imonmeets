import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { harness } from "./suite-harness.js";
import {
  fixtureManifestHash,
  verifiedAnalysisFixture,
} from "./analysis-fixtures.js";

test(
  "analysis persistence rejects an unverified worker and retains measured provenance",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async (t) => {
    let mode: "legacy" | "wrong" | "verified" = "legacy";
    const server = createServer((request, response) => {
      request.resume();
      const value = verifiedAnalysisFixture();
      const result =
        mode === "legacy"
          ? { ...value, provenance: undefined }
          : mode === "wrong"
            ? {
                ...value,
                provenance: {
                  ...value.provenance,
                  manifestSha256: "f".repeat(64),
                },
              }
            : value;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
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
      ANALYSIS_MODEL_MANIFEST_SHA256: fixtureManifestHash,
    });
    try {
      const owner = await h.signup("analysis-provenance@example.test");
      const workspace = await h.workspace(owner.cookie);
      const room = await h.room(owner.cookie, workspace.id);
      for (const selected of ["legacy", "wrong", "verified"] as const) {
        mode = selected;
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
        const path =
          "/api/workspaces/" +
          workspace.id +
          "/recordings/" +
          id +
          "/transcript";
        const response = await h.request(
          "POST",
          path,
          { language: "en", summary: false },
          owner.cookie,
        );
        assert.equal(response.statusCode, 200, response.body);
        let finished: { status: string; result: unknown } | undefined;
        for (let attempt = 0; attempt < 400; attempt++) {
          const row = (
            await h.pool.query(
              "SELECT status,result FROM im_recording_analysis WHERE recording_id=$1",
              [id],
            )
          ).rows[0];
          if (row?.status === "complete" || row?.status === "failed") {
            finished = row;
            break;
          }
          t.mock.timers.tick(5000);
          await delay(5);
        }
        assert.ok(finished, "bounded synthetic worker job must finish");
        if (selected === "verified") {
          assert.equal(finished.status, "complete");
          assert.deepEqual(finished.result, verifiedAnalysisFixture());
          const stored = await h.request("GET", path, undefined, owner.cookie);
          assert.equal(stored.statusCode, 200);
          assert.deepEqual(
            stored.json().job.provenance,
            verifiedAnalysisFixture().provenance,
          );
        } else {
          assert.equal(finished.status, "failed");
          assert.equal(
            finished.result,
            null,
            "unverified content is never persisted",
          );
        }
      }
    } finally {
      await h.close();
    }
  },
);
