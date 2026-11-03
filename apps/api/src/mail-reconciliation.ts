import type { Pool } from "pg";
import { z } from "zod";
import { transaction } from "./db.js";

export const reconciliationInput = z
  .object({
    idempotencyKey: z.string().regex(/^imonmeets-[a-f0-9]{64}$/),
    expectedVersion: z.number().int().nonnegative(),
    action: z.enum([
      "accepted",
      "abandoned",
      "delivered",
      "bounced",
      "complained",
    ]),
    operatorId: z.string().regex(/^[a-zA-Z0-9_.:@-]{1,100}$/),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    providerId: z
      .string()
      .min(1)
      .max(254)
      .regex(/^[^\r\n\u0000-\u001f]+$/)
      .optional(),
  })
  .strict();
export type MailReconciliation = z.infer<typeof reconciliationInput>;

// Server-operator function only. It never sends mail, refunds quota, removes a
// ledger row or makes an unresolved logical message eligible for another send.
// Evidence must be reviewed outside the application and its digest retained.
export async function reconcileMailDelivery(
  pool: Pool,
  input: MailReconciliation,
) {
  const b = reconciliationInput.parse(input);
  return transaction(pool, async (db) => {
    const result = await db.query(
      "SELECT state, delivery_status, provider_id, version, " +
        "lease_expires_at > now() AS active FROM im_email_deliveries " +
        "WHERE idempotency_key=$1 FOR UPDATE",
      [b.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Mail delivery record not found");
    if (row.version !== b.expectedVersion)
      throw new Error("Mail delivery changed; review the current version");
    if (row.state === "sending" && row.active)
      throw new Error("Mail delivery attempt is still active");
    const resolving = b.action === "accepted" || b.action === "abandoned";
    if (resolving && !["sending", "uncertain"].includes(row.state))
      throw new Error("Only an unresolved mail attempt can be reconciled");
    if (!resolving && row.state !== "accepted")
      throw new Error(
        "A delivery event requires a confirmed provider acceptance",
      );
    if (b.action !== "abandoned" && !(b.providerId ?? row.provider_id))
      throw new Error(
        "A provider message identifier is required for acceptance or delivery evidence",
      );
    if (row.provider_id && b.providerId && row.provider_id !== b.providerId)
      throw new Error("Provider message identifier does not match the ledger");
    if (!resolving) {
      const allowed: Record<string, string[]> = {
        accepted: ["delivered", "bounced", "complained"],
        delivered: ["bounced", "complained"],
        bounced: ["complained"],
        complained: [],
        unknown: [],
      };
      if (!allowed[row.delivery_status]?.includes(b.action))
        throw new Error(
          "Delivery event would repeat or reverse a terminal state",
        );
    }
    const state = b.action === "abandoned" ? "rejected" : "accepted";
    const delivery = b.action === "abandoned" ? "unknown" : b.action;
    await db.query(
      "INSERT INTO im_email_reconciliations " +
        "(idempotency_key, previous_version, action, operator_id, evidence_sha256, provider_id, previous_state, previous_delivery_status) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        b.idempotencyKey,
        row.version,
        b.action,
        b.operatorId,
        b.evidenceSha256,
        b.providerId ?? row.provider_id,
        row.state,
        row.delivery_status,
      ],
    );
    await db.query(
      "UPDATE im_email_deliveries SET state=$2, delivery_status=$3, provider_id=$4, " +
        "error_kind=$5, lease_expires_at=NULL, version=version+1, updated_at=now() " +
        "WHERE idempotency_key=$1 AND version=$6",
      [
        b.idempotencyKey,
        state,
        delivery,
        b.providerId ?? row.provider_id,
        b.action === "abandoned" ? "operator_abandoned_no_retry" : null,
        row.version,
      ],
    );
    return {
      idempotencyKey: b.idempotencyKey,
      state,
      deliveryStatus: delivery,
      version: row.version + 1,
    };
  });
}
