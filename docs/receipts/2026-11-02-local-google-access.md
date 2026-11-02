# Local Google Cloud access and deployment observation

## Scope

Continuation in the existing ordinary Pro conversation. No Work/Codex task, additional chat, external email, DNS change, OAuth credential, live deployment change or VPN change was made in this continuation.

## Mac / Google Cloud

- RDC device: MacBook-Pro-erdc.local, f4c00dd6-e429-4a98-bad0-8bbdb5344a35.
- Found the existing Google Cloud Chrome tab, ID 1346125836, in window 1346124845. It initially reported /enable-mfa?redirectTo=%2F; a subsequent observation reported /getting-started. These URLs do not establish that MFA or project setup is complete.
- Selected the existing tab; no duplicate project/client was created.
- Reading page text through Chrome AppleScript failed with error 12: JavaScript execution from Apple Events is disabled. Chrome points to View > Developer > Allow JavaScript from Apple Events.
- Did not enable that additional browser automation permission.
- macOS Accessibility access is already enabled. The inspected Chrome accessibility tree exposed browser controls but not the Cloud form. The signed-in Google account and selected project therefore remain unverified.
- Screenshot read calls returned pending/lookup_timeout. Their call IDs are f0f67da5-3b90-459d-b2d7-6fc5505e03c7 and ea4cd56d-ebbb-4b04-8a84-a7b1321ae046. No screenshot result was inspected, and the original pending calls were not reissued.
- Required owner action for the attempted Chrome automation path: enable Allow JavaScript from Apple Events in the existing Chrome profile, or explicitly authorize enabling that permission. No password or OAuth secret should be posted in chat.
- Intended OAuth origin: https://meets.imon.world:8443. Intended callback: https://meets.imon.world:8443/api/auth/callback/google. Existing reported project imonmeets must be verified before changes.

## Deployment observations (not a cutover receipt)

- Branch observed clean at 442df6d3a15bf209c55e35ad48d115d35398a0c2 before this receipt.
- Candidate image 9bb2dab-preview still has image digest sha256:601b62bbf561c82cc369f7ff8e920320f0745b9acfb4c8872fd94e3df623879e and revision 9bb2dab7a9356c0d75a5743e8c7f25ef7c77ab46.
- Live container remains healthy on imonmeets-app:91aae88, not the candidate.
- Found an existing /etc/nginx/conf.d/meets.imon.world.conf and private cutover-20261102T124640Z directory. Their contents/outcomes were not established in this continuation; do not overwrite or repeat an uncertain installation.
- Combined read of nginx configuration, private snapshot metadata and certificate logs was blocked by OpenAI tool safety checks. That operation was stopped, not retried by another route.
- Independent public HTTPS probe with normal certificate verification failed with curl code 60: certificate subject alternative names do not match meets.imon.world. Peer was 94.249.186.240. Verification was not disabled.
- Thus https://meets.imon.world:8443 is NOT accepted as a working TLS site yet. Do not report deployment or Google OAuth complete.
