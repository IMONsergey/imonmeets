import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMailer, MailDeliveryError } from "../src/auth.js";
import { harness } from "./suite-harness.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const mailEnv = {
  EMAIL_DELIVERY_MODE: "external",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "local-mock-provider-key-never-sent",
  SMTP_FROM: "noreply@example.test",
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

test(
  "unknown password-reset recipients cannot consume the shared delivery budget",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      for (const email of ["absent1@example.test", "absent2@example.test"]) {
        const r = await h.request("POST", "/api/auth/request-password-reset", {
          email,
          redirectTo: h.c.appUrl + "/reset-password",
        });
        assert.equal(r.statusCode, 200, r.body);
      }
      const budget = await h.pool.query(
        "SELECT count FROM im_rate_limits WHERE key=$1",
        [digest("smtp:global")],
      );
      assert.equal(
        budget.rowCount,
        0,
        "mail budget belongs to an actual provider attempt, not a reset request",
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_email_deliveries",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "an accepted logical mail consumes one delivery budget across duplicate calls",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      let calls = 0;
      const send = createMailer(h.c, h.pool, (async () => {
        calls++;
        return Response.json({ id: "mock-accepted" });
      }) as typeof fetch);
      await send("person@example.test", "Subject", "Stable body");
      await send("PERSON@example.test", "Subject", "Stable body");
      assert.equal(calls, 1);
      const budget = await h.pool.query(
        "SELECT count FROM im_rate_limits WHERE key=$1",
        [digest("smtp:global")],
      );
      assert.equal(budget.rows[0]?.count, 1);
    } finally {
      await h.close();
    }
  },
);

test(
  "concurrent distinct emails reserve the final quota atomically and rollback rejected reservations",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      const c = { ...h.c, limits: { ...h.c.limits, globalEmailDaily: 1 } };
      let calls = 0;
      const send = createMailer(c, h.pool, (async () => {
        calls++;
        return Response.json({ id: "mock-last-slot" });
      }) as typeof fetch);
      const results = await Promise.allSettled([
        send("first@example.test", "Subject", "One"),
        send("second@example.test", "Subject", "Two"),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const rejected = results.find(
        (r) => r.status === "rejected",
      ) as PromiseRejectedResult;
      assert.ok(rejected.reason instanceof MailDeliveryError);
      assert.equal(rejected.reason.kind, "rate_limited");
      assert.equal(calls, 1);
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_email_deliveries",
          )
        ).rows[0].n,
        1,
      );
      const budget = await h.pool.query(
        "SELECT count FROM im_rate_limits WHERE key=$1",
        [digest("smtp:global")],
      );
      assert.equal(budget.rows[0]?.count, 1);
    } finally {
      await h.close();
    }
  },
);

import { reconcileMailDelivery } from "../src/mail-reconciliation.js";
import { resendIdempotencyKey } from "../src/auth.js";

test(
  "SMTP shares the durable ledger and never replays accepted or uncertain sends",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      const c = { ...h.c, emailProvider: "smtp" as const };
      let calls = 0;
      const messages: string[] = [];
      const smtp = async (mail: { messageId: string }) => {
        calls++;
        messages.push(mail.messageId);
        return {
          messageId: mail.messageId,
          accepted: ["person@example.test"],
          rejected: [],
        };
      };
      const send = createMailer(c, h.pool, fetch, smtp);
      await send("person@example.test", "SMTP", "Stable");
      await send("person@example.test", "SMTP", "Stable");
      assert.equal(calls, 1);
      assert.match(messages[0]!, /^<imonmeets-[a-f0-9]{64}@imonmeets\.local>$/);
      const failing = createMailer(c, h.pool, fetch, async () => {
        calls++;
        throw new Error("socket closed after DATA");
      });
      await assert.rejects(
        failing("other@example.test", "SMTP", "Uncertain"),
        MailDeliveryError,
      );
      await assert.rejects(
        failing("other@example.test", "SMTP", "Uncertain"),
        MailDeliveryError,
      );
      assert.equal(calls, 2);
      assert.deepEqual(
        (
          await h.pool.query(
            "SELECT provider,state FROM im_email_deliveries ORDER BY state",
          )
        ).rows,
        [
          { provider: "smtp", state: "accepted" },
          { provider: "smtp", state: "uncertain" },
        ],
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "operator reconciliation is versioned, refuses active sends and never enables a replay",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      let calls = 0;
      const send = createMailer(h.c, h.pool, (async () => {
        calls++;
        throw new Error("network outcome unknown");
      }) as typeof fetch);
      await assert.rejects(
        send("person@example.test", "Subject", "Uncertain"),
        MailDeliveryError,
      );
      assert.ok(h.c.smtp.from);
    const key = resendIdempotencyKey(
        h.c.smtp.from,
        "person@example.test",
        "Subject",
        "Uncertain",
      );
      const base = {
        idempotencyKey: key,
        expectedVersion: 1,
        operatorId: "test-operator",
        evidenceSha256: digest("reviewed-provider-receipt"),
      };
      await assert.rejects(
        reconcileMailDelivery(h.pool, { ...base, action: "accepted" }),
        /identifier is required/,
      );
      await assert.rejects(
        reconcileMailDelivery(h.pool, {
          ...base,
          action: "accepted",
          providerId: "mock-provider",
          expectedVersion: 0,
        }),
        /changed/,
      );
      const accepted = await reconcileMailDelivery(h.pool, {
        ...base,
        action: "accepted",
        providerId: "mock-provider",
      });
      assert.equal(accepted.version, 2);
      await send("person@example.test", "Subject", "Uncertain");
      assert.equal(calls, 1);
      await assert.rejects(
        reconcileMailDelivery(h.pool, { ...base, action: "abandoned" }),
        /changed/,
      );
      const delivered = await reconcileMailDelivery(h.pool, {
        ...base,
        expectedVersion: 2,
        action: "delivered",
      });
      assert.equal(delivered.deliveryStatus, "delivered");
      await assert.rejects(
        reconcileMailDelivery(h.pool, {
          ...base,
          expectedVersion: 3,
          action: "delivered",
        }),
        /repeat or reverse/,
      );
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_email_reconciliations",
          )
        ).rows[0].n,
        2,
      );
      const active = "imonmeets-" + digest("active");
      await h.pool.query(
        "INSERT INTO im_email_deliveries(idempotency_key,recipient_hash,state,lease_expires_at) VALUES($1,$2,'sending',now()+interval '1 minute')",
        [active, digest("recipient")],
      );
      await assert.rejects(
        reconcileMailDelivery(h.pool, {
          ...base,
          idempotencyKey: active,
          expectedVersion: 0,
          action: "abandoned",
        }),
        /still active/,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "abandoned uncertain mail stays terminal and concurrent reconciliation has one winner",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      let calls = 0;
      const send = createMailer(h.c, h.pool, (async () => {
        calls++;
        throw new Error("timeout");
      }) as typeof fetch);
      await assert.rejects(
        send("person@example.test", "Subject", "Abandon"),
        MailDeliveryError,
      );
      assert.ok(h.c.smtp.from);
    const key = resendIdempotencyKey(
        h.c.smtp.from,
        "person@example.test",
        "Subject",
        "Abandon",
      );
      const input = {
        idempotencyKey: key,
        expectedVersion: 1,
        operatorId: "test-operator",
        evidenceSha256: digest("incident"),
        action: "abandoned" as const,
      };
      const results = await Promise.allSettled([
        reconcileMailDelivery(h.pool, input),
        reconcileMailDelivery(h.pool, input),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      await assert.rejects(
        send("person@example.test", "Subject", "Abandon"),
        (e: unknown) => e instanceof MailDeliveryError && e.kind === "rejected",
      );
      assert.equal(calls, 1);
    } finally {
      await h.close();
    }
  },
);

test(
  "exhausted send budget preserves password-reset anti-enumeration",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    try {
      await h.signup("existing@example.test");
      await h.pool.query(
        "INSERT INTO im_rate_limits(key,count,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [digest("smtp:global"), h.c.limits.globalEmailDaily],
      );
      const existing = await h.request(
        "POST",
        "/api/auth/request-password-reset",
        { email: "existing@example.test" },
      );
      const absent = await h.request(
        "POST",
        "/api/auth/request-password-reset",
        { email: "unknown@example.test" },
      );
      assert.equal(existing.statusCode, 200, existing.body);
      assert.equal(absent.statusCode, 200, absent.body);
      assert.deepEqual(existing.json(), absent.json());
      assert.equal(
        (
          await h.pool.query(
            "SELECT count(*)::int AS n FROM im_email_deliveries",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await h.close();
    }
  },
);

test(
  "public recovery response does not reveal provider latency for an existing account",
  { skip: !enabled },
  async () => {
    const h = await harness(mailEnv);
    const { createAuth, drainAuthTasks } = await import("../src/auth.js");
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      started = resolve;
    });
    let response: Promise<Response> | undefined;
    try {
      await h.signup("timing-existing@example.test");
      const auth = createAuth(h.c, h.pool, async () => {
        started();
        await hold;
      });
      response = auth.handler(
        new Request(h.c.appUrl + "/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json", origin: h.c.appUrl },
          body: JSON.stringify({ email: "timing-existing@example.test" }),
        }),
      );
      await called;
      const returnedWhileProviderPending = await Promise.race([
        response.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 250),
        ),
      ]);
      assert.equal(
        returnedWhileProviderPending,
        true,
        "HTTP response must not wait for the existing account's mail provider",
      );
      const existing = await response;
      assert.equal(existing.status, 200);
      const absent = await auth.handler(
        new Request(h.c.appUrl + "/api/auth/request-password-reset", {
          method: "POST",
          headers: { "content-type": "application/json", origin: h.c.appUrl },
          body: JSON.stringify({ email: "timing-absent@example.test" }),
        }),
      );
      assert.equal(absent.status, 200);
      assert.deepEqual(await existing.json(), await absent.json());
      let drained = false;
      const shutdown = drainAuthTasks(auth).then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        drained,
        false,
        "shutdown must retain the in-flight provider attempt",
      );
      release();
      await shutdown;
      assert.equal(drained, true);
    } finally {
      release();
      await response?.catch(() => {});
      await h.close();
    }
  },
);
