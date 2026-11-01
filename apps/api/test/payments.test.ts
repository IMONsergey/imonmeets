import test from "node:test";
import assert from "node:assert/strict";
import {
  createYookassaClient,
  kopecksToAmount,
  normalizeProviderPayment,
  paymentMatchesOrder,
  PaymentProviderError,
} from "../src/payments.js";

const config = {
  shopId: "123456",
  secretKey: "test_secret_not_a_real_key",
  testMode: true,
  appUrl: "https://imonmeets.example",
};
const input = {
  paymentId: "64bc3554-ccec-4de8-b096-e086980d9a2e",
  workspaceId: "workspace-a",
  userId: "user-a",
  planId: "team",
  amountKopecks: 99000,
  email: "payer@example.test",
};
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "22d6d597-000f-5000-9000-145f6df21d6f",
    status: "pending",
    paid: false,
    test: true,
    recipient: { account_id: "123456" },
    amount: { value: "990.00", currency: "RUB" },
    metadata: {
      paymentId: input.paymentId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      planId: input.planId,
    },
    created_at: "2026-11-01T11:00:00.000Z",
    confirmation: {
      type: "redirect",
      confirmation_url: "https://yoomoney.ru/checkout/payments/v2/contract",
    },
    ...overrides,
  };
}

test("payment amount uses exact integer kopecks", () => {
  assert.equal(kopecksToAmount(100), "1.00");
  assert.equal(kopecksToAmount(19901), "199.01");
  for (const invalid of [0, -1, 100.5, Number.NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(() => kopecksToAmount(invalid));
});

test("provider response binds merchant, amount, order metadata and test mode", () => {
  const normalized = normalizeProviderPayment(payment(), config);
  assert.equal(paymentMatchesOrder(normalized, input), true);
  for (const changed of [
    { workspaceId: "workspace-b" },
    { amountKopecks: 1 },
    { paymentId: "other" },
    { planId: "enterprise" },
    { userId: "other" },
  ])
    assert.equal(
      paymentMatchesOrder(normalized, { ...input, ...changed }),
      false,
    );
  for (const raw of [
    payment({ test: false }),
    payment({ recipient: { account_id: "other" } }),
    payment({ amount: { value: "990", currency: "RUB" } }),
    payment({ amount: { value: "990.00", currency: "USD" } }),
    payment({ metadata: {} }),
  ])
    assert.throws(
      () => normalizeProviderPayment(raw, config),
      PaymentProviderError,
    );
});

test("checkout destinations reject protocol, authority and deceptive domain variants", () => {
  for (const url of [
    "http://yoomoney.ru/pay",
    "https://yoomoney.ru.evil.example/pay",
    "https://yoomoney.ru@evil.example/pay",
    "https://evil.example/yoomoney.ru",
    "javascript:alert(1)",
    "https://yoomoney.ru:8443/pay",
  ]) {
    assert.throws(
      () =>
        normalizeProviderPayment(
          payment({
            confirmation: { type: "redirect", confirmation_url: url },
          }),
          config,
        ),
      PaymentProviderError,
    );
  }
});

test("create uses fixed provider endpoint, canonical return URL and persisted idempotence key", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Response.json(payment());
  }) as typeof fetch;
  const client = createYookassaClient(
    { ...config, receipt: { vatCode: 1 } },
    fetcher,
  );
  await client.createPayment(input);
  await client.createPayment(input);
  assert.equal(calls[0]!.url, "https://api.yookassa.ru/v3/payments");
  const headers = calls[0]!.init!.headers as Record<string, string>;
  assert.equal(headers["Idempotence-Key"], input.paymentId);
  const body = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(
    body.confirmation.return_url,
    `https://imonmeets.example/settings?section=plan&payment=${input.paymentId}&workspace=${input.workspaceId}`,
  );
  assert.equal(body.save_payment_method, false);
  assert.equal(body.receipt.customer.email, input.email);
  assert.deepEqual(body.amount, { value: "990.00", currency: "RUB" });
  assert.equal(calls[0]!.init!.body, calls[1]!.init!.body);
});

test("timeouts retain ambiguous status and provider failure payloads never escape", async () => {
  const network = createYookassaClient(config, (async () => {
    throw new Error("secret token or private provider response");
  }) as typeof fetch);
  await assert.rejects(
    network.createPayment(input),
    (e: unknown) =>
      e instanceof PaymentProviderError &&
      e.retryable &&
      !e.message.includes("secret"),
  );
  const unavailable = createYookassaClient(
    config,
    (async () =>
      new Response("personal details", { status: 503 })) as typeof fetch,
  );
  await assert.rejects(
    unavailable.createPayment(input),
    (e: unknown) => e instanceof PaymentProviderError && e.retryable,
  );
  const rejected = createYookassaClient(
    config,
    (async () =>
      new Response("private details", { status: 401 })) as typeof fetch,
  );
  await assert.rejects(
    rejected.getPayment(payment().id),
    (e: unknown) => e instanceof PaymentProviderError && !e.retryable,
  );
});

test("canonical lookup validates provider identifiers before making a request", async () => {
  let called = false;
  const client = createYookassaClient(config, (async () => {
    called = true;
    return Response.json(payment());
  }) as typeof fetch);
  await assert.rejects(client.getPayment("../../settings"));
  assert.equal(called, false);
  const result = await client.getPayment(payment().id);
  assert.equal(result.id, payment().id);
  assert.equal(called, true);
});
