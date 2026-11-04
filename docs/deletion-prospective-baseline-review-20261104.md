# Prospective deletion baseline: review limits

Date: 2026-11-04. Reviewed application source: `17147a6203814b5ea81de3eea547452496b2a6eb`.

**Status: source assessment only.** This note is not an accepted fenced baseline, an enrollment approval, a production execution receipt or complete deletion/restore acceptance. Its hash must not be supplied as baseline approval. It changes no application code or deployment requirement.

## Supported scope

The source supports a first reviewed baseline for the existing authoritative database from before the deletion journal. [`enrollReviewedDeletionBaseline`](../apps/api/src/deletion-binding.ts) records the accepted decision's SHA-256 and the exact journal UUID/genesis. It cannot replace an existing authority. The [enrollment CLI](../scripts/enroll-deletion-baseline.mjs) additionally requires a fresh independently signed complete-head checkpoint; its hash argument does not establish the truth of the underlying decision.

The [journal/restore runbook](deletion-journal-and-restore.md) explicitly limits retroactive coverage: pre-journal deletions cannot be reconstructed by introducing a new journal. It calls for a reviewed new backup baseline and disposition of older archives. The [legacy cutover procedure](release-2026-11-03/deployment-cutover-plan.md#legacy-baseline-procedure-preserve-current-data) describes adoption of the current authoritative database with an automatic-restore boundary. This scope does not authorize relabeling an old restored snapshot as a new current baseline.

A prospective decision can document adoption from a concrete writer fence while preserving unresolved history. It cannot certify historical deletion completeness or make an unmet acceptance step pass.

## Historical evidence that remains unresolved

The retained audit reports three `workspace.deleted` events. The handler in [`suite.ts`](../apps/api/src/suite.ts) deliberately calls `audit(db, null, u.id, "workspace.deleted", null)` after deletion; those event fields do not retain the deleted workspace identity. When the target UUIDs cannot be recovered, the events alone cannot prove that those particular workspaces are absent from the current database or every backup.

The older [preflight draft](verification/deployment-preflight-20261103.json) reports `historicalDeletedWorkspacesCurrentlyPresent: 0`. With null target identifiers, a zero match count is not an absence proof. Preserve the original draft as historical evidence; do not use that number as completed removal acceptance.

Step 3 of the legacy cutover procedure requires confirmation that the deleted workspaces remain absent. That item remains **unverified** while the targets are unknown. A prospective decision must retain this residual explicitly, for example:

| Evidence field                                           | Honest interpretation at this review                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Observed legacy workspace deletion events                | 3                                                      |
| Recoverable targets from the retained event fields       | 0                                                      |
| Addressed verification of those targets' current absence | Unverified                                             |
| Historical deletion completeness                         | Not established                                        |
| Prebaseline archives                                     | Offline-only; no automatic serving or fresh enrollment |

These are review limits, not a populated approval template. Read-only reconstruction from authorized backups may improve the evidence. If the available archives cannot resolve the targets, record that result; do not invent identifiers or historical journal intents.

This source assessment does not independently verify physical recording removal. Any operationally accepted recording absence must identify its actual storage/version/cache/backup scope and its evidence. Verified absence of known recordings does not resolve unknown workspace identities or prove deletion from every historical archive.

## Enforced restore boundary and its limits

[`ensureDeletionJournalBinding`](../apps/api/src/deletion-binding.ts) rejects a populated unbound database after migration and rejects an existing binding with another journal UUID/genesis. [`replayDeletionJournal`](../apps/api/src/deletion-replay.ts) checks that binding before accepting the independent checkpoint or replaying. [`createApp`](../apps/api/src/app.ts) completes replay before creating Fastify or starting application timers. The [binding regression suite](../apps/api/test/deletion-binding.integration.test.ts) covers populated pre-journal startup refusal, immutable authority and lost pre-binding snapshots.

This protects the normal journal-aware startup/replay path. The enrollment CLI cannot infer that a database under an ordinary production name came from an old archive. An administrator can also rewrite trusted state or select an old image. Therefore custody and recovery procedures must prohibit re-enrollment of prebaseline snapshots, copying a binding row into old data, serving restored data with a journal-unaware image, and rolling the journal or receiver backward.

If the database under review is an old restore with unestablished deletion obligations, the [binding runbook](deletion-database-binding.md#first-enrollment) requires that restore to remain blocked. Archive quarantine is a serving restriction; it is not evidence that deleted data was erased from the archive.

## Evidence required for the actual prospective decision

The accepted immutable record must identify the current database and its provenance, exact fenced inventory and recovery backup, unresolved removal review, older-backup inventory/custody policy, all stopped writers and maintenance, journal/genesis, independent receiver evidence, exact image/configuration, reviewer and time. It must distinguish the prospective decision from unresolved historical absence.

After enrollment, the runbook still requires a fresh backup containing the binding and isolated recovery acceptance before reopening traffic. Preserve the complete authority throughout recovery. These steps and the external deletion/readiness checks remain requirements; this note supplies no waiver and does not close DATA-02, REC-06, physical backup erasure or commercial launch acceptance.
