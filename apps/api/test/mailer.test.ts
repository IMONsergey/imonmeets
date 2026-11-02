import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import {
  createMailer,
  MailDeliveryError,
  resendIdempotencyKey,
} from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const apiKey = "resend-unit-test-key-never-used-for-network";

function resendConfig() {
  return loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://localhost/test",
    APP_URL: "https://imonmeets.vercel.app",
    BETTER_AUTH_SECRET: "ABCdef0123456789-random-strong-secret-sample",
    REGISTRATION_ENABLED: "false",
    EMAIL_DELIVERY_MODE: "external",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: apiKey,
    SMTP_FROM: "no-reply@notify.imon.world",
    EMAILS_PER_DAY: "45",
    EMAILS_PER_WORKSPACE_DAY: "45",
    EMAILS_PER_30D_BUCKET: "1000",
  });
}

type MemoryRow = {
  idempotency_key: string;
  recipient_hash: string;
  state: "sending" | "accepted" | "uncertain" | "rate_limited" | "rejected";
  provider_id: string | null;
  http_status: number | null;
  error_kind: string | null;
  retry_after_seconds: number | null;
};

class MemoryLedger {
  readonly rows = new Map<string, MemoryRow>();
  failNextUpdate = false;
  failNextInsert = false;

  async query(sql: string, values: unknown[] = []) {
    if (sql.startsWith("INSERT INTO im_email_deliveries")) {
      if (this.failNextInsert) {
        this.failNextInsert = false;
        throw new Error("simulated ledger reservation failure");
      }
      const [key, recipientHash] = values as [string, string];
      if (this.rows.has(key)) return { rowCount: 0, rows: [] };
      this.rows.set(key, {
        idempotency_key: key,
        recipient_hash: recipientHash,
        state: "sending",
        provider_id: null,
        http_status: null,
        error_kind: null,
        retry_after_seconds: null,
      });
      return { rowCount: 1, rows: [{ idempotency_key: key }] };
    }
    if (sql.startsWith("SELECT state, provider_id")) {
      const row = this.rows.get(String(values[0]));
      return {
        rowCount: row ? 1 : 0,
        rows: row
          ? [
              {
                state: row.state,
                provider_id: row.provider_id,
                http_status: row.http_status,
                error_kind: row.error_kind,
                retry_after_seconds: row.retry_after_seconds,
              },
            ]
          : [],
      };
    }
    if (sql.startsWith("UPDATE im_email_deliveries")) {
      if (this.failNextUpdate) {
        this.failNextUpdate = false;
        throw new Error("simulated database failure");
      }
      const [key, state, status, providerId, errorKind, retryAfter] =
        values as [
          string,
          MemoryRow["state"],
          number | null,
          string | null,
          string | null,
          number | null,
        ];
      const row = this.rows.get(key);
      if (!row || row.state !== "sending") return { rowCount: 0, rows: [] };
      Object.assign(row, {
        state,
        http_status: status,
        provider_id: providerId,
        error_kind: errorKind,
        retry_after_seconds: retryAfter,
      });
      return { rowCount: 1, rows: [] };
    }
    throw new Error("Unexpected mail ledger query");
  }
}

function newMailer(ledger: MemoryLedger, request: typeof fetch) {
  return createMailer(resendConfig(), ledger as unknown as Pool, request);
}

test("Resend sends through HTTPS with stable idempotency and no automatic retry", async () => {
  const ledger = new MemoryLedger();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init || {} });
    return new Response(JSON.stringify({ id: "mock-resend-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const mailer = newMailer(ledger, request);
  const first = await mailer(
    "Person@example.test",
    "Verify",
    "https://example.test/token",
  );
  const second = await mailer(
    "person@example.test",
    "Verify",
    "https://example.test/token",
  );
  assert.equal(first, undefined);
  assert.equal(second, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  assert.equal(calls[0]!.init.method, "POST");
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), "Bearer " + apiKey);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(
    headers.get("idempotency-key"),
    resendIdempotencyKey(
      "no-reply@notify.imon.world",
      "person@example.test",
      "Verify",
      "https://example.test/token",
    ),
  );
  assert.match(
    headers.get("idempotency-key") || "",
    /^imonmeets-[a-f0-9]{64}$/,
  );
  const payload = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(payload.to, ["person@example.test"]);
  assert.equal([...ledger.rows.values()][0]!.state, "accepted");
  assert.equal([...ledger.rows.values()][0]!.provider_id, "mock-resend-id");
  assert.equal(payload.from, "no-reply@notify.imon.world");
  assert.equal(payload.subject, "Verify");
  assert.equal(payload.text, "https://example.test/token");
  assert.equal(
    resendIdempotencyKey("from", " Person@example.test ", "s", "body"),
    resendIdempotencyKey("from", "person@example.test", "s", "body"),
  );
});

test("Resend 429 is rate-limited, exposes Retry-After and is not retried automatically", async () => {
  const ledger = new MemoryLedger();
  let calls = 0;
  const request = (async () => {
    calls += 1;
    return new Response("ignored", {
      status: 429,
      headers: { "retry-after": "60" },
    });
  }) as typeof fetch;
  const mailer = newMailer(ledger, request);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Body"),
    (error: unknown) =>
      error instanceof MailDeliveryError &&
      error.kind === "rate_limited" &&
      error.status === 429 &&
      error.retryAfterSeconds === 60 &&
      !error.message.includes(apiKey),
  );
  await assert.rejects(
    mailer("person@example.test", "Subject", "Body"),
    (error: unknown) =>
      error instanceof MailDeliveryError && error.kind === "rate_limited",
  );
  assert.equal(calls, 1);
  assert.equal([...ledger.rows.values()][0]!.state, "rate_limited");
});

test("Resend 5xx and network timeout are uncertain and are not blindly retried", async () => {
  for (const failure of [
    new Response("ignored", { status: 503 }),
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
  ]) {
    let calls = 0;
    const request = (async () => {
      calls += 1;
      if (failure instanceof Response) return failure;
      throw failure;
    }) as typeof fetch;
    const mailer = newMailer(new MemoryLedger(), request);
    await assert.rejects(
      mailer("person@example.test", "Subject", "Body"),
      (error: unknown) =>
        error instanceof MailDeliveryError &&
        error.kind === "uncertain" &&
        !error.message.includes(apiKey),
    );
    await assert.rejects(
      mailer("person@example.test", "Subject", "Body"),
      (error: unknown) =>
        error instanceof MailDeliveryError && error.kind === "uncertain",
    );
    assert.equal(calls, 1);
  }
});

test("Resend 4xx rejection is permanent and no response body or credential leaks", async () => {
  let calls = 0;
  const request = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ message: "sensitive provider body" }),
      {
        status: 403,
      },
    );
  }) as typeof fetch;
  const mailer = newMailer(new MemoryLedger(), request);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Body"),
    (error: unknown) =>
      error instanceof MailDeliveryError &&
      error.kind === "rejected" &&
      error.status === 403 &&
      !error.message.includes("sensitive provider body") &&
      !error.message.includes(apiKey),
  );
  assert.equal(calls, 1);
});

test("Resend invalid success response is treated as uncertain", async () => {
  const request = (async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const mailer = newMailer(new MemoryLedger(), request);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Body"),
    (error: unknown) =>
      error instanceof MailDeliveryError && error.kind === "uncertain",
  );
});

test("concurrent duplicate and post-restart accepted delivery never call Resend twice", async () => {
  const ledger = new MemoryLedger();
  let calls = 0;
  let release!: (response: Response) => void;
  const request = (async () => {
    calls += 1;
    return await new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  const mailer = newMailer(ledger, request);
  const first = mailer("person@example.test", "Subject", "Stable body");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await assert.rejects(
    mailer(" PERSON@example.test ", "Subject", "Stable body"),
    (error: unknown) =>
      error instanceof MailDeliveryError &&
      error.kind === "uncertain" &&
      /unresolved/.test(error.message),
  );
  release(
    new Response(JSON.stringify({ id: "resend-durable-id" }), { status: 200 }),
  );
  await first;
  const restartedMailer = newMailer(ledger, (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "unexpected" }), { status: 200 });
  }) as typeof fetch);
  await restartedMailer("person@example.test", "Subject", "Stable body");
  assert.equal(calls, 1);
  const row = [...ledger.rows.values()][0]!;
  assert.equal(row.state, "accepted");
  assert.equal(row.provider_id, "resend-durable-id");
});

test("a crash-left sending row fails closed after restart without a blind replay", async () => {
  const ledger = new MemoryLedger();
  const key = resendIdempotencyKey(
    "no-reply@notify.imon.world",
    "person@example.test",
    "Subject",
    "Stable body",
  );
  ledger.rows.set(key, {
    idempotency_key: key,
    recipient_hash: "hashed-recipient",
    state: "sending",
    provider_id: null,
    http_status: null,
    error_kind: null,
    retry_after_seconds: null,
  });
  let calls = 0;
  const mailer = newMailer(ledger, (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "should-not-send" }), {
      status: 200,
    });
  }) as typeof fetch);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Stable body"),
    (error: unknown) =>
      error instanceof MailDeliveryError && error.kind === "uncertain",
  );
  assert.equal(calls, 0);
});

test("failure to persist accepted provider ID leaves sending state and blocks replay", async () => {
  const ledger = new MemoryLedger();
  ledger.failNextUpdate = true;
  let calls = 0;
  const mailer = newMailer(ledger, (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "accepted-but-not-persisted" }), {
      status: 200,
    });
  }) as typeof fetch);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Stable body"),
    (error: unknown) =>
      error instanceof MailDeliveryError &&
      error.kind === "uncertain" &&
      /unresolved/.test(error.message),
  );
  assert.equal(calls, 1);
  const restartedMailer = newMailer(ledger, (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "duplicate" }), { status: 200 });
  }) as typeof fetch);
  await assert.rejects(
    restartedMailer("person@example.test", "Subject", "Stable body"),
    (error: unknown) =>
      error instanceof MailDeliveryError && error.kind === "uncertain",
  );
  assert.equal(calls, 1);
});

test("provider ID and recipient content are never exposed in delivery errors", async () => {
  const ledger = new MemoryLedger();
  const mailer = newMailer(
    ledger,
    (async () =>
      new Response(JSON.stringify({ id: "provider-private-id" }), {
        status: 200,
      })) as typeof fetch,
  );
  await mailer("person@example.test", "Password reset", "secret-token-body");
  const row = [...ledger.rows.values()][0]!;
  assert.equal(row.provider_id, "provider-private-id");
  assert.equal(JSON.stringify(row).includes("secret-token-body"), false);
  assert.equal(JSON.stringify(row).includes("person@example.test"), false);
});

test(
  "PostgreSQL email ledger serializes concurrent sends and survives a new pool",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, createHash } = await import("node:crypto");
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "mail_test_" + randomUUID().replaceAll("-", "");
    await admin.query('CREATE SCHEMA "' + schema + '"');
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set("options", "-csearch_path=" + schema);
    let pool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      await pool.query(
        "CREATE TABLE im_email_deliveries (" +
          "idempotency_key text PRIMARY KEY, recipient_hash text NOT NULL, " +
          "state text NOT NULL CHECK(state IN ('sending','accepted','uncertain','rate_limited','rejected')), " +
          "provider_id text, http_status integer, error_kind text, " +
          "retry_after_seconds integer, created_at timestamptz NOT NULL DEFAULT now(), " +
          "updated_at timestamptz NOT NULL DEFAULT now())",
      );
      let calls = 0;
      let release!: (response: Response) => void;
      let notifyCalled!: () => void;
      const called = new Promise<void>((resolve) => {
        notifyCalled = resolve;
      });
      const request = (async () => {
        calls += 1;
        notifyCalled();
        return await new Promise<Response>((resolve) => {
          release = resolve;
        });
      }) as typeof fetch;
      const firstMailer = createMailer(resendConfig(), pool, request);
      const first = firstMailer(
        "person@example.test",
        "Subject",
        "Stable body",
      );
      const started = await Promise.race([
        called.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 5000),
        ),
      ]);
      if (!started) await first;
      assert.equal(calls, 1);
      const concurrentMailer = createMailer(resendConfig(), pool, (async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: "duplicate" }), {
          status: 200,
        });
      }) as typeof fetch);
      await assert.rejects(
        concurrentMailer(" PERSON@example.test ", "Subject", "Stable body"),
        (error: unknown) =>
          error instanceof MailDeliveryError && error.kind === "uncertain",
      );
      release(
        new Response(JSON.stringify({ id: "pg-provider-id" }), { status: 200 }),
      );
      await first;
      const saved = await pool.query(
        "SELECT state, provider_id, recipient_hash FROM im_email_deliveries",
      );
      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0].state, "accepted");
      assert.equal(saved.rows[0].provider_id, "pg-provider-id");
      assert.equal(
        saved.rows[0].recipient_hash,
        createHash("sha256").update("person@example.test").digest("hex"),
      );
      await pool.end();

      pool = new Pool({ connectionString: databaseUrl.toString() });
      const restartedMailer = createMailer(resendConfig(), pool, (async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: "unexpected" }), {
          status: 200,
        });
      }) as typeof fetch);
      await restartedMailer("person@example.test", "Subject", "Stable body");
      assert.equal(calls, 1);
      const afterRestart = await pool.query(
        "SELECT state, provider_id FROM im_email_deliveries",
      );
      assert.equal(afterRestart.rows[0].state, "accepted");
      assert.equal(afterRestart.rows[0].provider_id, "pg-provider-id");

      const unresolvedKey = resendIdempotencyKey(
        "no-reply@notify.imon.world",
        "crash@example.test",
        "Subject",
        "Crash before outcome",
      );
      await pool.query(
        "INSERT INTO im_email_deliveries (idempotency_key, recipient_hash, state) " +
          "VALUES ($1, $2, 'sending')",
        [
          unresolvedKey,
          createHash("sha256").update("crash@example.test").digest("hex"),
        ],
      );
      await assert.rejects(
        restartedMailer(
          "crash@example.test",
          "Subject",
          "Crash before outcome",
        ),
        (error: unknown) =>
          error instanceof MailDeliveryError && error.kind === "uncertain",
      );
      assert.equal(calls, 1);
    } finally {
      await pool.end().catch(() => {});
      await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await admin.end();
    }
  },
);

test(
  "PostgreSQL email budget is atomic under concurrency and persists after pool restart",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { postgresLimiter } = await import("../src/limits.js");
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = "budget_test_" + randomUUID().replaceAll("-", "");
    await admin.query('CREATE SCHEMA "' + schema + '"');
    const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
    databaseUrl.searchParams.set("options", "-csearch_path=" + schema);
    let pool = new Pool({ connectionString: databaseUrl.toString() });
    try {
      await pool.query(
        "CREATE TABLE im_rate_limits (" +
          "key text PRIMARY KEY, count integer NOT NULL, " +
          "expires_at timestamptz NOT NULL)",
      );
      const limiter = postgresLimiter(pool);
      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          limiter.consume("smtp:global", 45, 86400),
        ),
      );
      assert.equal(results.filter((result) => result.allowed).length, 45);
      assert.equal(results.filter((result) => !result.allowed).length, 55);
      const saved = await pool.query("SELECT count FROM im_rate_limits");
      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0].count, 46);
      const monthlyResults = await Promise.all(
        Array.from({ length: 1100 }, () =>
          limiter.consume("smtp:global:30d", 1000, 30 * 86400),
        ),
      );
      assert.equal(
        monthlyResults.filter((result) => result.allowed).length,
        1000,
      );
      assert.equal(
        monthlyResults.filter((result) => !result.allowed).length,
        100,
      );
      const beforeRestart = await pool.query(
        "SELECT key, count FROM im_rate_limits ORDER BY key",
      );
      assert.equal(beforeRestart.rows.length, 2);
      await pool.end();

      pool = new Pool({ connectionString: databaseUrl.toString() });
      const restarted = postgresLimiter(pool);
      const afterRestartDaily = await restarted.consume(
        "smtp:global",
        45,
        86400,
      );
      const afterRestartMonthly = await restarted.consume(
        "smtp:global:30d",
        1000,
        30 * 86400,
      );
      assert.equal(afterRestartDaily.allowed, false);
      assert.equal(afterRestartMonthly.allowed, false);
      const persisted = await pool.query(
        "SELECT count FROM im_rate_limits ORDER BY key",
      );
      assert.deepEqual(
        persisted.rows.map((row) => row.count).sort((a, b) => a - b),
        [46, 1001],
      );
    } finally {
      await pool.end().catch(() => {});
      await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      await admin.end();
    }
  },
);

test("unavailable durable ledger fails closed before any Resend request", async () => {
  const ledger = new MemoryLedger();
  ledger.failNextInsert = true;
  let calls = 0;
  const mailer = newMailer(ledger, (async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: "must-not-send" }), {
      status: 200,
    });
  }) as typeof fetch);
  await assert.rejects(
    mailer("person@example.test", "Subject", "Body"),
    (error: unknown) =>
      error instanceof MailDeliveryError && error.kind === "ledger",
  );
  assert.equal(calls, 0);
  assert.equal(ledger.rows.size, 0);
});
