# Public pages and ingress verification

2026-11-03T06:28:10.514589+00:00

Bounded isolated verification, CPU1/RAM2GiB/Tasks256. Production unchanged.

- scripts/prepare-ingress443.mjs: d749f58adebd20acb53089b132d3e4b7ea1165c0ca1eca8b37cc9317177ad5de
- scripts/prepare-turn.mjs: 73978cd7c6c94ba3a0b3e7b977f71e11a87afd692e02e905f8fd6f3d2584921d
- apps/api/src/public-information.ts: e0d0eb7ca23fcb66eb1d19fbe93bad3e5875020644b0a795c682a123992b0530
- apps/web/src/pages/Public.tsx: b600146920bffb2ec2e00a9d6331ea817e00a07319b55186ce474135c5583fcf
- scripts/check-launch-readiness.mjs: 72cf924fb9f5a120ca148bc1b8075d6e04f8d607d36824d8f66522ee63a3f12b

{
  "checkedAt": "2026-11-03T06:28:10.514589+00:00",
  "results": [
    {
      "command": [
        "node",
        "--version"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "node",
        "node_modules/prettier/bin/prettier.cjs",
        "--write",
        "apps/api/src/public-information.ts",
        "apps/api/src/config.ts",
        "apps/api/src/app.ts",
        "apps/api/test/public-information.test.ts",
        "apps/api/test/embedding.test.ts",
        "apps/web/src/App.tsx",
        "apps/web/src/api.ts",
        "apps/web/src/main.tsx",
        "apps/web/src/pages/Public.tsx",
        "apps/web/src/pages/Auth.tsx",
        "apps/web/src/pages/Workspace.tsx",
        "apps/web/src/public.browser.test.ts",
        "apps/web/src/styles/public.css",
        "scripts/check-launch-readiness.mjs",
        "scripts/test-launch-readiness.mjs",
        "scripts/check-mail-delivery.mjs",
        "scripts/prepare-ingress443.mjs",
        "scripts/prepare-turn.mjs",
        "compose.yml",
        "compose.turn.yml",
        "compose.ingress443.yml",
        "compose.public-documents.yml",
        "docs/ingress443.md",
        "docs/public-information.md",
        "scripts/create-release-manifest.mjs",
        "scripts/test-release-manifest.mjs",
        "docs/release-manifest.md",
        "apps/api/test/auth-google.test.ts",
        "apps/web/src/app.browser.test.ts"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "npm",
        "run",
        "typecheck"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "npm",
        "run",
        "build"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "node",
        "--import",
        "tsx",
        "--test",
        "apps/api/test/public-information.test.ts",
        "apps/api/test/embedding.test.ts"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "node",
        "--test",
        "scripts/test-launch-readiness.mjs",
        "scripts/test-release-manifest.mjs"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "python3",
        "scripts/test-ingress443.py"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "node",
        "--import",
        "tsx",
        "--test",
        "apps/web/src/public.browser.test.ts"
      ],
      "exitCode": 0
    },
    {
      "command": [
        "git",
        "diff",
        "--check"
      ],
      "exitCode": 0
    }
  ],
  "passed": true,
  "cpuQuota": "100%",
  "memoryMax": "2GiB",
  "tasksMax": 256,
  "productionChanges": false
}


COMMAND ["node", "--version"]
v24.21.0

COMMAND ["node", "node_modules/prettier/bin/prettier.cjs", "--write", "apps/api/src/public-information.ts", "apps/api/src/config.ts", "apps/api/src/app.ts", "apps/api/test/public-information.test.ts", "apps/api/test/embedding.test.ts", "apps/web/src/App.tsx", "apps/web/src/api.ts", "apps/web/src/main.tsx", "apps/web/src/pages/Public.tsx", "apps/web/src/pages/Auth.tsx", "apps/web/src/pages/Workspace.tsx", "apps/web/src/public.browser.test.ts", "apps/web/src/styles/public.css", "scripts/check-launch-readiness.mjs", "scripts/test-launch-readiness.mjs", "scripts/check-mail-delivery.mjs", "scripts/prepare-ingress443.mjs", "scripts/prepare-turn.mjs", "compose.yml", "compose.turn.yml", "compose.ingress443.yml", "compose.public-documents.yml", "docs/ingress443.md", "docs/public-information.md", "scripts/create-release-manifest.mjs", "scripts/test-release-manifest.mjs", "docs/release-manifest.md", "apps/api/test/auth-google.test.ts", "apps/web/src/app.browser.test.ts"]
apps/api/src/public-information.ts 261ms (unchanged)
apps/api/src/config.ts 130ms (unchanged)
apps/api/src/app.ts 1003ms (unchanged)
apps/api/test/public-information.test.ts 15ms (unchanged)
apps/api/test/embedding.test.ts 83ms (unchanged)
apps/web/src/App.tsx 214ms (unchanged)
apps/web/src/api.ts 201ms (unchanged)
apps/web/src/main.tsx 6ms (unchanged)
apps/web/src/pages/Public.tsx 134ms (unchanged)
apps/web/src/pages/Auth.tsx 296ms (unchanged)
apps/web/src/pages/Workspace.tsx 446ms (unchanged)
apps/web/src/public.browser.test.ts 88ms (unchanged)
apps/web/src/styles/public.css 129ms (unchanged)
scripts/check-launch-readiness.mjs 175ms (unchanged)
scripts/test-launch-readiness.mjs 173ms (unchanged)
scripts/check-mail-delivery.mjs 8ms (unchanged)
scripts/prepare-ingress443.mjs 73ms (unchanged)
scripts/prepare-turn.mjs 14ms (unchanged)
compose.yml 113ms (unchanged)
compose.turn.yml 9ms (unchanged)
compose.ingress443.yml 8ms (unchanged)
compose.public-documents.yml 4ms (unchanged)
docs/ingress443.md 205ms (unchanged)
docs/public-information.md 110ms (unchanged)
scripts/create-release-manifest.mjs 76ms
scripts/test-release-manifest.mjs 9ms
docs/release-manifest.md 9ms (unchanged)
apps/api/test/auth-google.test.ts 152ms (unchanged)
apps/web/src/app.browser.test.ts 132ms (unchanged)

COMMAND ["npm", "run", "typecheck"]

> imonmeets@0.1.0 typecheck
> npm run typecheck --workspaces && tsc -p tsconfig.e2e.json


> @imonmeets/api@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json


> @imonmeets/web@0.1.0 typecheck
> tsc --noEmit


COMMAND ["npm", "run", "build"]

> imonmeets@0.1.0 build
> npm run build -w @imonmeets/web && npm run build -w @imonmeets/api


> @imonmeets/web@0.1.0 build
> tsc --noEmit && vite build

vite v8.3.5 building client environment for production...
transforming...
✓ 2103 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                             0.69 kB │ gzip:   0.42 kB
dist/sdk/v1/embed-protocol.js               2.56 kB
dist/sdk/v1/embed.js                        4.78 kB
dist/sdk/v1/index.js                        5.26 kB
dist/assets/index-DpdjlmqO.css             81.65 kB │ gzip:  15.75 kB
dist/assets/rolldown-runtime-WkwZ5CU-.js    0.59 kB │ gzip:   0.36 kB
dist/assets/Embed-DifgeS8E.js               4.37 kB │ gzip:   1.99 kB
dist/assets/api-CC9eqfQZ.js                 9.44 kB │ gzip:   4.21 kB
dist/assets/browser-COyxp469.js            23.46 kB │ gzip:   8.86 kB
dist/assets/App-GofcPreG.js               142.14 kB │ gzip:  36.21 kB
dist/assets/index-BCc4htFI.js             230.14 kB │ gzip:  72.76 kB
dist/assets/Join-DQg0nt82.js              695.84 kB │ gzip: 187.74 kB

[plugin builtin:vite-reporter] 
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rolldownOptions.output.codeSplitting to improve chunking: https://rolldown.rs/reference/OutputOptions.codeSplitting
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 3.77s

> @imonmeets/api@0.1.0 build
> tsc -p tsconfig.json


COMMAND ["node", "--import", "tsx", "--test", "apps/api/test/public-information.test.ts", "apps/api/test/embedding.test.ts"]
(node:176255) [FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the logController option with disableRequestLogging or isLogDisabled override instead. The disableRequestLogging top-level option will be removed in `fastify@6`.
(Use `node --trace-warnings ...` to show where the warning was created)
✔ embedding is disabled by default and origins are exact and header-safe (4.199661ms)
✔ only the dedicated guest document can be framed (0.863951ms)
✔ Vercel keeps framing protection on account paths and proxies only guest embeds (1.512078ms)
2026-11-03T06:27:49.907Z ERROR [Better Auth]: Could not validate the database schema. Check your database connection.
✔ guest framing is served by the authenticated origin without exposing accounts to CORS (610.452846ms)
✔ unapproved legal drafts are never loaded or published (2.687302ms)
✔ published documents bind reviewed bytes, identity and version; HTML remains plain text (5.384085ms)
✔ frontend routes have a bounded allowlist and unknown documents get HTTP404 (0.401514ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6199.440956

COMMAND ["node", "--test", "scripts/test-launch-readiness.mjs", "scripts/test-release-manifest.mjs"]
✔ healthy free service does not claim commercial launch, disabled optional features do not block it (7.45639ms)
✔ signaling health does not replace external media and target capacity acceptance (2.615261ms)
✔ Mac-dependent notifications or unverified incident/recovery delivery do not pass independent alerts (1.377567ms)
✔ previous alert acceptance requires a fresh working independent monitor now (1.432736ms)
✔ captured mail with closed signup is a healthy preview, not a public launch (0.425385ms)
✔ SMTP queue acceptance alone and an unrelated sender receipt cannot pass delivery (1.68605ms)
✔ Resend is configured without SMTP but still requires delivered mail and complete account flows (2.47076ms)
✔ provider fingerprints invalidate a different transport and never hash secrets or unused SMTP fields (1.179234ms)
✔ exact release identity binds all capability receipts and missing identity blocks launch only (1.278115ms)
✔ ordinary HTTPS and WSS ports are required even if old nonstandard-port receipts claim success (1.329696ms)
✔ public recording endpoint and model manifest changes invalidate only their capability evidence (0.612467ms)
✔ stale, future or timezone-less operations never produce a healthy service (2.098454ms)
✔ disk failures, omitted checks and explicit aggregate failure are preserved (0.752568ms)
✔ local dump success and a manual offsite copy are not evidence of automatic offsite recovery (1.213624ms)
✔ recording enabled with credentials still requires lifecycle, restore and object-copy evidence (0.671339ms)
✔ enabled AI needs a private worker and real execution evidence (0.409835ms)
✔ live billing requires separate merchant, fiscal, terms and full payment acceptance (0.660418ms)
✔ result never leaks raw configuration, evidence, secrets, email or endpoint values (0.426645ms)
✔ CLI reads bounded evidence without modifying files and handles unreadable input safely (78.46996ms)
✔ legal approval requires actual reviewed public documents and fresh exact evidence (1.218605ms)
✔ release identity rejects dirty source, mismatched image revision and ambiguous tags (1.72056ms)
✔ manifest binds migration bytes and capability hashes, excludes secrets and never claims deployment (32.116495ms)
ℹ tests 22
ℹ suites 0
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 358.44219

COMMAND ["python3", "scripts/test-ingress443.py"]
v24.21.0
PASS actual nginx and pinned HAProxy syntax
PASS TLS web homepage on SNI route
PASS PROXY v2 client address and forged trusted header replacement
PASS public internal API path blocked
PASS /rtc accepts authorized and fails closed before upstream on revoke/expiry/unavailability
PASS /rtc/validate accepts authorized and fails closed before upstream on revoke/expiry/unavailability
PASS /rtc/v1 accepts authorized and fails closed before upstream on revoke/expiry/unavailability
PASS /rtc/v1/validate accepts authorized and fails closed before upstream on revoke/expiry/unavailability
PASS bearer supported, conflicting credentials and methods rejected
PASS authorized WebSocket upgrade survives gate
PASS signaling management and internal admission not public
PASS recording signature inputs preserved, writes and bucket list blocked
PASS TURN SNI receives intact TLS stream without PROXY prefix (routing only)
PASS HTTP canonical redirect and ACME webroot
PASS unknown SNI rejected
PASS unsafe candidate inputs refused
PASS actual candidate generation is private and refuses overwrite
PASS actual TURN preparation:443 loopback, legacy fallback, private files and certificate coverage
{"passed": 18, "checks": ["actual nginx and pinned HAProxy syntax", "TLS web homepage on SNI route", "PROXY v2 client address and forged trusted header replacement", "public internal API path blocked", "/rtc accepts authorized and fails closed before upstream on revoke/expiry/unavailability", "/rtc/validate accepts authorized and fails closed before upstream on revoke/expiry/unavailability", "/rtc/v1 accepts authorized and fails closed before upstream on revoke/expiry/unavailability", "/rtc/v1/validate accepts authorized and fails closed before upstream on revoke/expiry/unavailability", "bearer supported, conflicting credentials and methods rejected", "authorized WebSocket upgrade survives gate", "signaling management and internal admission not public", "recording signature inputs preserved, writes and bucket list blocked", "TURN SNI receives intact TLS stream without PROXY prefix (routing only)", "HTTP canonical redirect and ACME webroot", "unknown SNI rejected", "unsafe candidate inputs refused", "actual candidate generation is private and refuses overwrite", "actual TURN preparation:443 loopback, legacy fallback, private files and certificate coverage"], "realExternalMedia": false, "productionChanges": false}

COMMAND ["node", "--import", "tsx", "--test", "apps/web/src/public.browser.test.ts"]
✔ public pages, safe legal rendering and mobile personal-security status (11378.916171ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14397.121287

COMMAND ["git", "diff", "--check"]
