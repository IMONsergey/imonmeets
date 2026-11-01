import { z } from "zod";

/** Server-only adapter. The browser never supplies an amount or a merchant key. */
export type YookassaConfig = {
  shopId: string;
  secretKey: string;
  testMode: boolean;
  appUrl: string;
  receipt?: { vatCode: number; taxSystemCode?: number };
};

export type PaymentInput = {
  paymentId: string;
  workspaceId: string;
  planId: string;
  userId: string;
  amountKopecks: number;
  email: string;
};

const providerId = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const metadataSchema = z.object({
  paymentId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  planId: z.string().min(1).max(64),
  userId: z.string().min(1).max(128),
});
const providerSchema = z.object({
  id: providerId,
  status: z.enum(["pending", "waiting_for_capture", "succeeded", "canceled"]),
  paid: z.boolean(),
  test: z.boolean(),
  amount: z.object({
    value: z.string().regex(/^\d{1,9}\.\d{2}$/),
    currency: z.literal("RUB"),
  }),
  recipient: z.object({ account_id: z.string() }),
  metadata: metadataSchema,
  confirmation: z
    .object({ type: z.string(), confirmation_url: z.string().optional() })
    .optional(),
  created_at: z.iso.datetime(),
  captured_at: z.iso.datetime().optional(),
  refunded_amount: z
    .object({
      value: z.string().regex(/^\d{1,9}\.\d{2}$/),
      currency: z.literal("RUB"),
    })
    .optional(),
});

export type ProviderPayment = {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  test: boolean;
  amountKopecks: number;
  currency: "RUB";
  refundedKopecks: number;
  metadata: z.infer<typeof metadataSchema>;
  confirmationUrl: string | null;
  createdAt: string;
  capturedAt: string | null;
};

export class PaymentProviderError extends Error {
  constructor(
    public readonly code: "UNAVAILABLE" | "REJECTED" | "INVALID_RESPONSE",
    public readonly retryable: boolean,
  ) {
    // Provider responses can contain contact details. Never attach raw responses.
    super(`Payment provider: ${code}`);
    this.name = "PaymentProviderError";
  }
}

export function kopecksToAmount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 100 || value > 99_999_999_999)
    throw new Error(
      "Payment amount must be integer kopecks between 100 and 99999999999",
    );
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function toKopecks(value: string): number {
  const [rubles, cents] = value.split(".");
  return Number(rubles) * 100 + Number(cents);
}

function confirmationUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentProviderError("INVALID_RESPONSE", false);
  }
  const allowed = ["yoomoney.ru", "yookassa.ru"].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowed
  )
    throw new PaymentProviderError("INVALID_RESPONSE", false);
  return url.href;
}

export function normalizeProviderPayment(
  raw: unknown,
  config: Pick<YookassaConfig, "shopId" | "testMode">,
): ProviderPayment {
  const parsed = providerSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.test !== config.testMode ||
    parsed.data.recipient.account_id !== config.shopId
  )
    throw new PaymentProviderError("INVALID_RESPONSE", false);
  const data = parsed.data;
  return {
    id: data.id,
    status: data.status,
    paid: data.paid,
    test: data.test,
    amountKopecks: toKopecks(data.amount.value),
    currency: "RUB",
    refundedKopecks: data.refunded_amount
      ? toKopecks(data.refunded_amount.value)
      : 0,
    metadata: data.metadata,
    confirmationUrl: confirmationUrl(data.confirmation?.confirmation_url),
    createdAt: data.created_at,
    capturedAt: data.captured_at ?? null,
  };
}

/** Apply only to an independently fetched provider object, never a webhook body. */
export function paymentMatchesOrder(
  payment: ProviderPayment,
  expected: Omit<PaymentInput, "email">,
): boolean {
  return (
    payment.amountKopecks === expected.amountKopecks &&
    payment.currency === "RUB" &&
    payment.metadata.paymentId === expected.paymentId &&
    payment.metadata.workspaceId === expected.workspaceId &&
    payment.metadata.planId === expected.planId &&
    payment.metadata.userId === expected.userId
  );
}

export function createYookassaClient(
  config: YookassaConfig,
  request: typeof fetch = fetch,
) {
  if (!/^\d{1,20}$/.test(config.shopId) || config.secretKey.length < 16)
    throw new Error("YooKassa merchant credentials are incomplete");
  const appUrl = new URL(config.appUrl);
  if (appUrl.protocol !== "https:" || appUrl.username || appUrl.password)
    throw new Error("Payment return URL must use the canonical HTTPS origin");
  if (
    config.receipt &&
    (!Number.isInteger(config.receipt.vatCode) ||
      config.receipt.vatCode < 1 ||
      config.receipt.vatCode > 12 ||
      (config.receipt.taxSystemCode !== undefined &&
        (!Number.isInteger(config.receipt.taxSystemCode) ||
          config.receipt.taxSystemCode < 1 ||
          config.receipt.taxSystemCode > 6)))
  )
    throw new Error("Receipt tax settings must be explicitly configured");

  async function call(
    path: string,
    init: RequestInit = {},
  ): Promise<ProviderPayment> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    try {
      const response = await request(`https://api.yookassa.ru/v3/${path}`, {
        ...init,
        signal: controller.signal,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${config.shopId}:${config.secretKey}`).toString("base64")}`,
          ...init.headers,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new PaymentProviderError(
          response.status === 429 || response.status >= 500
            ? "UNAVAILABLE"
            : "REJECTED",
          response.status === 429 || response.status >= 500,
        );
      }
      // Bound response memory even when the peer uses chunked transfer encoding.
      if (!response.body)
        throw new PaymentProviderError("INVALID_RESPONSE", false);
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 512 * 1024) {
            await reader.cancel();
            throw new PaymentProviderError("INVALID_RESPONSE", false);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new PaymentProviderError("INVALID_RESPONSE", false);
      }
      return normalizeProviderPayment(raw, config);
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      // Network timeouts are ambiguous. The caller must reuse the same persisted idempotency key.
      throw new PaymentProviderError("UNAVAILABLE", true);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async createPayment(input: PaymentInput) {
      const paymentId = z.uuid().parse(input.paymentId);
      const metadata = metadataSchema.parse({
        paymentId,
        workspaceId: input.workspaceId,
        planId: input.planId,
        userId: input.userId,
      });
      const value = kopecksToAmount(input.amountKopecks);
      const returnUrl = new URL("/settings", appUrl.origin);
      returnUrl.searchParams.set("section", "plan");
      returnUrl.searchParams.set("payment", paymentId);
      returnUrl.searchParams.set("workspace", input.workspaceId);
      const email = z.email().max(254).parse(input.email);
      return call("payments", {
        method: "POST",
        headers: { "Idempotence-Key": paymentId },
        body: JSON.stringify({
          amount: { value, currency: "RUB" },
          capture: true,
          confirmation: { type: "redirect", return_url: returnUrl.href },
          description: `IMON Meets: ${input.planId}, 30 дней`,
          metadata,
          // No automatic renewals and no stored payment method without a separate consent flow.
          save_payment_method: false,
          ...(config.receipt
            ? {
                receipt: {
                  customer: { email },
                  ...(config.receipt.taxSystemCode
                    ? { tax_system_code: config.receipt.taxSystemCode }
                    : {}),
                  items: [
                    {
                      description: "Доступ к IMON Meets на 30 дней",
                      quantity: "1.00",
                      amount: { value, currency: "RUB" },
                      vat_code: config.receipt.vatCode,
                      payment_subject: "service",
                      payment_mode: "full_payment",
                    },
                  ],
                },
              }
            : {}),
        }),
      });
    },
    async getPayment(id: string) {
      return call(`payments/${providerId.parse(id)}`);
    },
  };
}

export type PaymentClient = ReturnType<typeof createYookassaClient>;
