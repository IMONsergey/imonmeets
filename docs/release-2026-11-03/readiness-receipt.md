# Readiness verification

Executed 2026-11-03T05:42:44.004470+00:00 through Desktop Commander in a bounded systemd unit (CPU1, RAM2GiB). No external service calls or production changes.

Scope: provider-aware email, exact release/configuration identity, standard HTTPS/WSS ports and strict media evidence.

- `scripts/check-launch-readiness.mjs`: `d702b765262b0ee731297f514dfc36a496ac903c6a7bbee2038795dddbd45982`
- `scripts/test-launch-readiness.mjs`: `fbe00906bb1808042081c0cb3c987e1966ac24f0d3d46b0cf2035468e278642b`
- `docs/launch-readiness.md`: `4f3aab59d62d049fa7db47e048700cf7ecd096f383f24c54b8d62c902af60741`

```text
v24.21.0
scripts/check-launch-readiness.mjs 305ms
scripts/test-launch-readiness.mjs 184ms
docs/launch-readiness.md 231ms
docs/release-2026-11-03/PLAN.md 16ms (unchanged)
docs/release-2026-11-03/backlog.json 103ms (unchanged)
✔ healthy free service does not claim commercial launch, disabled optional features do not block it (4.965002ms)
✔ signaling health does not replace external media and target capacity acceptance (2.726024ms)
✔ Mac-dependent notifications or unverified incident/recovery delivery do not pass independent alerts (1.244535ms)
✔ previous alert acceptance requires a fresh working independent monitor now (1.005163ms)
✔ captured mail with closed signup is a healthy preview, not a public launch (0.464765ms)
✔ SMTP queue acceptance alone and an unrelated sender receipt cannot pass delivery (1.335677ms)
✔ Resend is configured without SMTP but still requires delivered mail and complete account flows (2.063715ms)
✔ provider fingerprints invalidate a different transport and never hash secrets or unused SMTP fields (0.997943ms)
✔ exact release identity binds all capability receipts and missing identity blocks launch only (1.364666ms)
✔ ordinary HTTPS and WSS ports are required even if old nonstandard-port receipts claim success (1.289197ms)
✔ public recording endpoint and model manifest changes invalidate only their capability evidence (0.417635ms)
✔ stale, future or timezone-less operations never produce a healthy service (1.267725ms)
✔ disk failures, omitted checks and explicit aggregate failure are preserved (1.025872ms)
✔ local dump success and a manual offsite copy are not evidence of automatic offsite recovery (1.114944ms)
✔ recording enabled with credentials still requires lifecycle, restore and object-copy evidence (0.741669ms)
✔ enabled AI needs a private worker and real execution evidence (0.335764ms)
✔ live billing requires separate merchant, fiscal, terms and full payment acceptance (0.612337ms)
✔ result never leaks raw configuration, evidence, secrets, email or endpoint values (0.482856ms)
✔ CLI reads bounded evidence without modifying files and handles unreadable input safely (37.725612ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 94.442328

```
