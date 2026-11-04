# Room quota and waiting cancellation — 4 November 2026

This is a bounded follow-up to the Google/auth release based on
`a3d816ff28cb4692d07c950d92642207a57f9a58`. It does not introduce the full deletion
journal, witness binding, or media admission architecture. No database migration
or runtime configuration change is required by these patches.

## Changes

Commit `4aa5c75` counts only `status='open'` rooms for both admission enforcement
and plan usage. Creation retains the existing workspace lock, so concurrent
creation cannot spend the same remaining slot. Closing a room releases its slot
once. Closed rooms, chat and recordings remain in history. Billing and meeting
copy explicitly describe the quota as open rooms.

Commit `79fa752` makes cancellation intent synchronous in the browser. Clicking
Cancel stops polling, aborts pending poll/join requests, rejects their late
completions, and clears the locally persisted waiting grant before the server
responds. A failed cancellation leaves automatic admission stopped and offers a
retry or a return to the device check.

The server cancellation uses the same workspace → room → ticket lock order as
join. An unused matching ticket can be denied idempotently. If join already
consumed the ticket, cancellation returns HTTP 409
`WAITING_CANCELLATION_UNVERIFIED` instead of a false success. A supplied ticket
remains bound to its room, generation, account and status when the organizer
turns off the waiting room. Fresh requests without a ticket still follow the
current room policy.

## Regression coverage

- `apps/api/test/room-quota.integration.test.ts`: pilot and commercial quota,
  usage/enforcement agreement, tenant isolation, concurrent create, idempotent
  close, and preservation of closed-room chat/history.
- `apps/api/test/waiting-cancellation.integration.test.ts`: cancellation of an
  unused ticket, sibling isolation, late host admission rejection, disabled
  waiting-room policy, honest consumed-ticket result, and an actual PostgreSQL
  lock race between join and cancellation.
- `apps/web/src/waiting-cancellation.browser.test.ts`: ordinary admission,
  deferred poll after cancellation, deferred join after cancellation, and failed
  cancellation. It checks real Join/WaitingGuest components, no call mount after
  cancellation, aborted requests and immediate local grant removal. Requests are
  intercepted, physical device capture is denied, and media sockets are blocked.
  The normal `test:ui` entry imports this fixture.

## Verification checkpoint

Source review and `git diff --check` passed. The integrated runtime source is
`44355fda9350b392dee12e7c8bf16ec50c6b5a35`; both changes passed independent review.

Frozen quota RED job `20261104T094646-d41ef2755e` ran the exact `a3d816` baseline
with the new regression file. Both pilot and commercial cases reached the
closure assertion and failed as intended: usage was 2 instead of 1. There were
2 tests, 2 expected failures and no skips. The earlier mutable-worktree job
`20261104T094422-a8a53fe109` was cancelled before execution.

The integrated GREEN job `20261104T101010-8b97ef52fc` passed 11 API checks and
5 browser checks (the parent fixture and four scenarios), with no failures or
skips. Formatting, all TypeScript checks and API/web builds also passed.
[GitHub Actions 41812430093](https://github.com/IMONsergey/imonmeets/actions/runs/41812430093)
passed every workflow step for the same source: API 83/83, web 18/18, SDK 7/7,
readiness 14/14 and browser 9/9. The existing concurrency fixture was aligned to
open-room usage in `44355fd` while preserving its strict `[200, 409]` result.
See [the sanitized integrated receipt](../reviewed-results/2026-11-04-google-auth/followup-verification.json)
for source identity, counts and compiled hashes. No deployment was performed by
these verification steps.

The local test environment is restricted to the disposable commercial-test
PostgreSQL container at loopback port 55441, with a new random schema for each
harness and cleanup of only that schema. No test points at the production DB.

## Deliberate limits

This patch does not revoke a media token that the server already issued. It
prevents this client from using a late response and honestly refuses to confirm
server cancellation after consumption. Full token revocation, kick/ban and
protected signaling require the larger reviewed admission architecture and all
public RTC ingress paths to enforce it.

The narrow release still has unbounded room/history listing endpoints. Removing
the incorrect lifetime room cap makes pagination more important, but bounded
history is not claimed as implemented here. Closing rooms does not delete their
history or recordings.
