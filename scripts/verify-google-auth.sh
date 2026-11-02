#!/usr/bin/env bash
set -euo pipefail
export IMON_BROWSER_EXECUTABLE=/usr/bin/google-chrome-stable
./node_modules/.bin/prettier --check \
  apps/api/src/app.ts apps/api/src/auth.ts apps/api/src/config.ts apps/api/src/db.ts apps/api/test/policy.test.ts apps/api/test/auth-google.test.ts apps/api/test/mailer.test.ts \
  apps/web/src/App.tsx apps/web/src/api.ts apps/web/src/app.browser.test.ts \
  apps/web/src/pages/Auth.tsx apps/web/src/pages/AuthenticatorSettings.tsx apps/web/src/pages/Workspace.tsx \
  apps/web/src/styles/auth.css compose.yml docs/google-oauth.md docs/email-activation.md
npm run typecheck
npm run build
npm test
npm run test:ui
