import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CreditCard,
  ShieldCheck,
} from "lucide-react";
import { api, date } from "../api";
import type { Workspace } from "../api";
import { Button, ErrorBox, Spinner } from "../ui";

type Limits = {
  rooms: number;
  members: number;
  participants: number;
  activeRecordings: number;
  recordingRetentionDays: number;
  chatRetentionDays: number;
};
type Payment = {
  id: string;
  status:
    | "creating"
    | "pending"
    | "waiting_for_capture"
    | "succeeded"
    | "canceled"
    | "refunded";
  amountKopecks: number;
  currency: "RUB";
  test: boolean;
  createdAt: string;
  confirmationUrl: string | null;
  appliedAt: string | null;
};
type Plan = {
  plan: { id: string; name: string; limits: Limits };
  usage: {
    rooms: number;
    members: number;
    recordingBytes: number;
    activeRecordings: number;
  };
  billingEnabled: boolean;
  testMode?: boolean;
  paidUntil?: string | null;
  offer?: {
    id: "pro";
    name: string;
    amountKopecks: number;
    currency: "RUB";
    periodDays: number;
    limits: Limits;
  } | null;
  payments?: Payment[];
};
type CheckoutRequest = { requestId: string; paymentId?: string };
const checkoutKey = (workspaceId: string) => `imon.checkout.${workspaceId}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pendingStatuses = new Set<Payment["status"]>([
  "creating",
  "pending",
  "waiting_for_capture",
]);
const labels: Record<Payment["status"], string> = {
  creating: "Подготавливается",
  pending: "Ожидает оплаты",
  waiting_for_capture: "Подтверждается",
  succeeded: "Оплачен",
  canceled: "Отменен",
  refunded: "Возвращен",
};
const money = (kopecks: number) =>
  new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(
    kopecks / 100,
  );
function checkoutUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["yookassa.ru", "yoomoney.ru"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error(
      "Платежный сервис вернул некорректный адрес. Повторите проверку статуса.",
    );
  return url.toString();
}
function readCheckout(workspaceId: string): CheckoutRequest | undefined {
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(checkoutKey(workspaceId)) ?? "null",
    );
    if (
      saved &&
      typeof saved.requestId === "string" &&
      uuid.test(saved.requestId)
    )
      return saved;
  } catch {
    /* The in-memory request still prevents accidental retries. */
  }
  return undefined;
}
function saveCheckout(workspaceId: string, request?: CheckoutRequest) {
  try {
    if (request)
      sessionStorage.setItem(checkoutKey(workspaceId), JSON.stringify(request));
    else sessionStorage.removeItem(checkoutKey(workspaceId));
  } catch {
    /* Optional storage. */
  }
}

export function PlanSettings({ workspace }: { workspace: Workspace }) {
  const [plan, setPlan] = useState<Plan>();
  const [error, setError] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [busy, setBusy] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [returnedPaymentId] = useState(() => {
    const id = new URLSearchParams(location.search).get("payment");
    return id && uuid.test(id) ? id : null;
  });
  const [returnedPayment, setReturnedPayment] = useState<Payment>();
  const [checkingReturn, setCheckingReturn] = useState(
    Boolean(returnedPaymentId),
  );
  const checkout = useRef<CheckoutRequest | undefined>(
    readCheckout(workspace.id),
  );
  const mounted = useRef(true);
  const owner = workspace.role === "owner";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const rememberPayment = useCallback(
    (payment: Payment) => {
      if (checkout.current?.paymentId === payment.id) {
        if (!pendingStatuses.has(payment.status)) {
          checkout.current = undefined;
          saveCheckout(workspace.id);
        } else {
          checkout.current = { ...checkout.current, paymentId: payment.id };
          saveCheckout(workspace.id, checkout.current);
        }
      }
      if (payment.id === returnedPaymentId) {
        setReturnedPayment(payment);
        if (
          !pendingStatuses.has(payment.status) &&
          !(payment.status === "succeeded" && !payment.appliedAt)
        )
          setCheckingReturn(false);
      }
      setRefresh((value) => value + 1);
    },
    [workspace.id, returnedPaymentId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void api<Plan>(`/workspaces/${workspace.id}/plan`, undefined, undefined, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setPlan(value);
        setError("");
        const prior = value.payments?.find(
          (payment) => payment.id === checkout.current?.paymentId,
        );
        if (prior && !pendingStatuses.has(prior.status)) {
          checkout.current = undefined;
          saveCheckout(workspace.id);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [workspace.id, refresh]);
  useEffect(() => {
    if (!returnedPaymentId || !owner) {
      setCheckingReturn(false);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const check = async () => {
      attempts++;
      try {
        const result = await api<{ payment: Payment }>(
          `/workspaces/${workspace.id}/payments/${returnedPaymentId}/refresh`,
          {},
          "POST",
          { signal: controller.signal, timeoutMs: 25_000 },
        );
        if (controller.signal.aborted) return;
        rememberPayment(result.payment);
        setPaymentError("");
        const unsettled =
          pendingStatuses.has(result.payment.status) ||
          (result.payment.status === "succeeded" && !result.payment.appliedAt);
        if (unsettled && attempts < 12)
          timer = setTimeout(() => void check(), 5000);
        else setCheckingReturn(false);
      } catch (e) {
        if (!controller.signal.aborted) {
          setPaymentError((e as Error).message);
          setCheckingReturn(false);
        }
      }
    };
    void check();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [workspace.id, returnedPaymentId, owner, rememberPayment]);
  const refreshPayment = async (payment: Payment) => {
    setBusy(payment.id);
    setPaymentError("");
    try {
      const result = await api<{ payment: Payment }>(
        `/workspaces/${workspace.id}/payments/${payment.id}/refresh`,
        {},
        "POST",
        { timeoutMs: 25_000 },
      );
      if (mounted.current) rememberPayment(result.payment);
    } catch (e) {
      if (mounted.current) setPaymentError((e as Error).message);
    } finally {
      if (mounted.current) setBusy("");
    }
  };
  const activePayment = plan?.payments?.find(
    (payment) =>
      pendingStatuses.has(payment.status) ||
      (payment.status === "succeeded" && !payment.appliedAt),
  );
  const rows = plan
    ? [
        [
          "Открытые комнаты",
          `${plan.usage.rooms} из ${plan.plan.limits.rooms}`,
        ],
        [
          "Участники пространства",
          `${plan.usage.members} из ${plan.plan.limits.members}`,
        ],
        ["Участники одной встречи", `до ${plan.plan.limits.participants}`],
        [
          "Одновременные записи",
          `${plan.usage.activeRecordings} из ${plan.plan.limits.activeRecordings}`,
        ],
        [
          "Объем записей",
          `${(plan.usage.recordingBytes / 1024 / 1024).toLocaleString("ru", { maximumFractionDigits: 1 })} МБ`,
        ],
        ["Хранение записей", `${plan.plan.limits.recordingRetentionDays} дней`],
        ["Хранение чата", `${plan.plan.limits.chatRetentionDays} дней`],
      ]
    : [];
  return (
    <>
      <div className="workspace-section-heading">
        <h2>Тариф и использование</h2>
        <CreditCard size={18} />
      </div>
      <ErrorBox error={error} />
      <ErrorBox error={paymentError} />
      {!plan && !error && <Spinner />}
      {returnedPaymentId && (
        <div
          className={`payment-return ${returnedPayment?.status === "succeeded" && returnedPayment.appliedAt ? "success" : ""}`}
          role="status"
        >
          {checkingReturn ? (
            <Spinner />
          ) : returnedPayment?.status === "succeeded" &&
            returnedPayment.appliedAt ? (
            <CheckCircle2 size={20} />
          ) : (
            <CreditCard size={20} />
          )}
          <div>
            <strong>
              {returnedPayment?.status === "succeeded" &&
              returnedPayment.appliedAt
                ? returnedPayment.test
                  ? "Тестовый платеж подтвержден"
                  : "Платеж подтвержден"
                : returnedPayment?.status === "canceled"
                  ? "Платеж отменен"
                  : returnedPayment?.status === "refunded"
                    ? "Платеж возвращен"
                    : returnedPayment?.status === "succeeded"
                      ? "Подтверждаем доступ"
                      : checkingReturn
                        ? "Проверяем оплату"
                        : "Оплата пока не подтверждена"}
            </strong>
            <p>
              {returnedPayment?.status === "succeeded" &&
              returnedPayment.appliedAt
                ? "Доступ обновлен после проверки платежа на сервере."
                : !owner
                  ? "Проверить платеж может владелец пространства."
                  : "Возврат с платежной страницы еще не подтверждает оплату. Дождитесь проверки или обновите статус платежа."}
            </p>
          </div>
        </div>
      )}
      {plan && (
        <>
          <div className="plan-summary">
            <div>
              <span>Текущий тариф</span>
              <h3>{plan.plan.name}</h3>
              {plan.paidUntil && <p>Оплачен до {date(plan.paidUntil)}</p>}
            </div>
            <ShieldCheck size={24} />
          </div>
          <dl className="plan-limits">
            {rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {!plan.billingEnabled && (
            <div className="workspace-notice">
              <CreditCard size={18} />
              <span>
                Онлайн-оплата пока недоступна. Текущий доступ и ограничения
                пространства показаны выше.
              </span>
            </div>
          )}
          {plan.billingEnabled && plan.offer && (
            <section className="billing-offer">
              {plan.testMode && (
                <span className="billing-test-badge">
                  Тестовый режим оплаты
                </span>
              )}
              <div className="billing-offer-heading">
                <h3>{plan.offer.name}</h3>
                <strong>
                  {money(plan.offer.amountKopecks)}
                  <small>на {plan.offer.periodDays} дней</small>
                </strong>
              </div>
              <p>
                До {plan.offer.limits.members} участников пространства и до{" "}
                {plan.offer.limits.participants} участников встречи. Открытых
                комнат: {plan.offer.limits.rooms}. Хранение записей:{" "}
                {plan.offer.limits.recordingRetentionDays} дней.
              </p>
              <p className="form-note">
                Продление вручную. Автоматических списаний нет.
              </p>
              {owner ? (
                <Button
                  className="primary"
                  busy={busy === "checkout"}
                  disabled={!!busy || !!activePayment}
                  onClick={async () => {
                    if (busy || activePayment) return;
                    setBusy("checkout");
                    setPaymentError("");
                    if (!checkout.current) {
                      checkout.current = { requestId: crypto.randomUUID() };
                      saveCheckout(workspace.id, checkout.current);
                    }
                    try {
                      const result = await api<{ payment: Payment }>(
                        `/workspaces/${workspace.id}/payments`,
                        {
                          planId: "pro",
                          requestId: checkout.current.requestId,
                        },
                        "POST",
                        { timeoutMs: 25_000 },
                      );
                      if (!mounted.current) return;
                      checkout.current = {
                        ...checkout.current!,
                        paymentId: result.payment.id,
                      };
                      saveCheckout(workspace.id, checkout.current);
                      rememberPayment(result.payment);
                      if (
                        result.payment.confirmationUrl &&
                        pendingStatuses.has(result.payment.status)
                      )
                        location.assign(
                          checkoutUrl(result.payment.confirmationUrl),
                        );
                    } catch (e) {
                      if (mounted.current)
                        setPaymentError((e as Error).message);
                    } finally {
                      if (mounted.current) setBusy("");
                    }
                  }}
                >
                  {activePayment
                    ? "Есть незавершенный платеж"
                    : plan.testMode
                      ? "Проверить тестовую оплату"
                      : "Оплатить 30 дней"}
                  <ArrowUpRight size={17} />
                </Button>
              ) : (
                <p className="form-note">
                  Оплатить тариф может владелец пространства.
                </p>
              )}
            </section>
          )}
          {!!plan.payments?.length && (
            <section className="billing-history">
              <h3>История платежей</h3>
              {plan.payments.map((payment) => (
                <article className="billing-payment" key={payment.id}>
                  <div className="billing-payment-info">
                    <strong>{money(payment.amountKopecks)}</strong>
                    <span>{date(payment.createdAt)}</span>
                    {payment.test && (
                      <small className="billing-test-badge">
                        Тестовый платеж
                      </small>
                    )}
                  </div>
                  <span
                    className={`workspace-status ${payment.status === "succeeded" && payment.appliedAt ? "success" : "neutral"}`}
                  >
                    {payment.status === "succeeded" && !payment.appliedAt
                      ? "Подтверждаем доступ"
                      : labels[payment.status]}
                  </span>
                  {owner &&
                    (pendingStatuses.has(payment.status) ||
                      (payment.status === "succeeded" &&
                        !payment.appliedAt)) && (
                      <div className="billing-payment-actions">
                        {payment.confirmationUrl && (
                          <Button
                            disabled={!!busy}
                            onClick={() => {
                              try {
                                location.assign(
                                  checkoutUrl(payment.confirmationUrl!),
                                );
                              } catch (e) {
                                setPaymentError((e as Error).message);
                              }
                            }}
                          >
                            Продолжить оплату
                            <ArrowUpRight size={15} />
                          </Button>
                        )}
                        <Button
                          busy={busy === payment.id}
                          disabled={!!busy}
                          onClick={() => void refreshPayment(payment)}
                        >
                          Проверить статус
                        </Button>
                      </div>
                    )}
                </article>
              ))}
            </section>
          )}
        </>
      )}
      <Button
        disabled={!!busy}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Обновить использование
      </Button>
    </>
  );
}
