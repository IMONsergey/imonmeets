# Waiting cancellation: client acceptance, 2026-11-03

Base source: ddd429bf92b889b8ed424e345cf80b4b3e620c34. Isolated branch, Remote Desktop Commander. Production and shared release were not modified.

## Confirmed defect

A cancellation click previously waited for DELETE before invalidating the admission operation. A late waiting-status=admitted response could start /join while cancellation was pending. A /join already in flight could subsequently switch the UI into the call flow. The deferred-response regressions failed on both behaviors before the fix. Cancellation failure also lacked a local exit back to device preview.

## Change

WaitingGuest synchronously stops its polling and aborts the admission signal on cancellation. Join passes that signal to the API request and also rejects late completion even when the transport completes after abort. A failed cancellation leaves automatic admission stopped, with retry-cancel and local exit controls. Ordinary uncancelled admission remains possible.

This is a client behavior guarantee. At this commit, server-side cancellation of an already-consumed waiting ticket does not prove revocation of a previously issued media grant. That API boundary is a separate follow-up.

## Evidence

- red.json / red.log: all three negative cases failed before production-code edits.
- green.json / green.log: normal admission and three cancellation cases passed; 5 node tests including their parent, zero skips.
- regression.json / regression.log: frontend typecheck, existing suite and embedded-browser regressions, plus cancellation cases passed; 7 node tests including the cancellation parent, zero skips. The final fixture-only additions restore real call CSS and are covered by green.json.
- Source hashes are recorded in the receipts. Test execution: one worker, shared verification lock, CPU 1, RAM 2 GiB, bounded systemd unit.
- The browser fixture renders the real Join and WaitingGuest components with deferred synthetic API responses. It explicitly denies physical device capture and all WebSocket connections. No external service, real participant, email or payment was used.
- The final mobile cancellation-error screenshot was inspected. Its horizontal overflow assertion passed at 390x844. This is not a full accessibility or device acceptance.

The regression is imported by app.browser.test.ts, so npm run test:ui includes it in CI.
