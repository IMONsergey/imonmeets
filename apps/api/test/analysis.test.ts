import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  ANALYSIS_TIMEOUT_MS,
  WORKER_BUSY_DELAYS_MS,
  AnalysisWorkerBusyError,
  analysisResultSchema,
  readAnalysisResponse,
  requestAnalysis,
  retryBusyWorker,
} from "../src/analysis.js";

const result = {
  text: "Проверка записи",
  segments: [{ start: 0, end: 2.5, text: "Проверка записи" }],
  language: "ru",
  duration: 3,
  model: "faster-whisper-small",
};
test("analysis output bounds segment time, text and duration and strips extra fields", async () => {
  assert.deepEqual(
    await readAnalysisResponse(
      Response.json({ ...result, secret: "not-persisted" }),
    ),
    result,
  );
  for (const value of [
    { ...result, duration: 3601 },
    { ...result, segments: [{ start: 3, end: 1, text: "invalid" }] },
    { ...result, text: "a".repeat(500001) },
  ])
    assert.equal(analysisResultSchema.safeParse(value).success, false);
});
test("untrusted malformed or oversized worker responses cannot be persisted", async () => {
  await assert.rejects(
    readAnalysisResponse(
      new Response("secret provider details", { status: 503 }),
    ),
  );
  await assert.rejects(readAnalysisResponse(new Response("not-json")));
  await assert.rejects(
    readAnalysisResponse(new Response("x".repeat(2 * 1024 * 1024 + 1))),
  );
});

const job = {
  jobId: "b72869ed-f2eb-4013-8085-4793d5930dd6",
  objectKey:
    "recordings/cb39e1bf-0bfd-4a4c-aea8-c2f77e57438d/b72869ed-f2eb-4013-8085-4793d5930dd6.mp4",
  language: "ru",
  summary: false,
};
async function worker(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
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
  return "http://127.0.0.1:" + address.port;
}

test("native analysis transport survives five minutes without headers and preserves the private request", async (t) => {
  let respond: (() => void) | undefined;
  let received!: () => void;
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  const url = await worker(t, (request, response) => {
    assert.equal(request.url, "/transcribe");
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.authorization,
      "Bearer synthetic-worker-secret",
    );
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), job);
      respond = () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      };
      received();
    });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = requestAnalysis(
    url,
    "synthetic-worker-secret",
    job,
    new AbortController().signal,
  ).finally(() => {
    settled = true;
  });
  await ready;
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(ANALYSIS_TIMEOUT_MS, 90 * 60 * 1000);
  respond!();
  assert.deepEqual(await pending, result);
});

test("analysis transport bounds response bytes, refuses redirects and distinguishes a busy worker", async (t) => {
  let mode: "busy" | "redirect" | "oversized" = "busy";
  let calls = 0;
  const url = await worker(t, (_request, response) => {
    calls++;
    if (mode === "busy") {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "WORKER_BUSY" }));
    } else if (mode === "redirect") {
      response.writeHead(302, {
        Location: "http://127.0.0.1:1/private-secret",
      });
      response.end("{}");
    } else response.end("x".repeat(2 * 1024 * 1024 + 1));
  });
  const request = () =>
    requestAnalysis(url, "synthetic", job, new AbortController().signal);
  await assert.rejects(request, AnalysisWorkerBusyError);
  mode = "redirect";
  await assert.rejects(request, /worker unavailable/);
  mode = "oversized";
  await assert.rejects(request, /too large/);
  assert.equal(calls, 3);
});

test("analysis transport cancellation and deadline close the pending worker connection", async (t) => {
  for (const cancel of [true, false]) {
    let received!: () => void;
    let disconnected!: () => void;
    const ready = new Promise<void>((resolve) => {
      received = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const url = await worker(t, (request, response) => {
      request.resume();
      response.once("close", disconnected);
      received();
    });
    const controller = new AbortController();
    const pending = requestAnalysis(
      url,
      "synthetic",
      job,
      controller.signal,
      cancel ? 1000 : 40,
    );
    const rejected = assert.rejects(pending, cancel ? /abort/i : /timed out/);
    await ready;
    if (cancel) controller.abort();
    await rejected;
    await closed;
  }
});

test("busy worker retries are bounded, abortable and restricted to explicit occupancy", async () => {
  const waits: number[] = [];
  let calls = 0;
  const controller = new AbortController();
  assert.equal(
    await retryBusyWorker(
      async () => {
        if (++calls < 3) throw new AnalysisWorkerBusyError();
        return "complete";
      },
      controller.signal,
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    ),
    "complete",
  );
  assert.deepEqual(waits, WORKER_BUSY_DELAYS_MS.slice(0, 2));
  calls = 0;
  await assert.rejects(
    retryBusyWorker(
      async () => {
        calls++;
        throw new AnalysisWorkerBusyError();
      },
      controller.signal,
      async () => {},
    ),
    AnalysisWorkerBusyError,
  );
  assert.equal(calls, WORKER_BUSY_DELAYS_MS.length + 1);
  calls = 0;
  await assert.rejects(
    retryBusyWorker(
      async () => {
        calls++;
        throw new Error("Not an occupancy error");
      },
      controller.signal,
      async () => assert.fail("Unrelated errors must not be retried"),
    ),
    /Not an occupancy error/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryBusyWorker(
      async () => {
        calls++;
        throw new AnalysisWorkerBusyError();
      },
      controller.signal,
      async () => controller.abort(),
    ),
    /abort/i,
  );
  assert.equal(calls, 1);
});
