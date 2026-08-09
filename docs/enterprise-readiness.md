# Enterprise readiness operations

## Database roles and RLS

`DATABASE_URL` must use a non-owner PostgreSQL role without `BYPASSRLS`. `SYSTEM_DATABASE_URL` is reserved for migrations, auth bootstrap, scheduled cross-tenant maintenance, SCIM/API-key tenant resolution, exports, and deletion. Set `DATABASE_RLS_ENABLED=true` only after deploying the RLS migration and validating both connections. The app sets `app.organization_id` with `SET LOCAL` inside transactions; missing or conflicting tenant context fails closed.

Validate in staging by creating two organizations, writing one flow per organization, setting `app.organization_id` to the first organization, and verifying direct SQL cannot select or mutate the second. Repeat for every table listed in the RLS migration and its relation-owned child tables.

## Backup restoration

`npm run backup:create` emits a custom-format dump and SHA-256 manifest. `npm run backup:verify` checksum-validates, restores into the explicitly confirmed disposable `RESTORE_DATABASE_URL`, and queries required tables and migration health. The weekly workflow is the durable proof; retain its manifest and logs. Never point the verification secret at production.

## Load test

Run `BASE_URL=https://staging.example BACKSTORY_API_KEY=... FLOW_ID=... npm run load:platform`. The five-minute profile ramps reads to 100 virtual users while admitting flow runs at a controlled arrival rate. Release thresholds are under 1% request failures, read p95 under 500ms/p99 under 1.2s, and run-admission p95 under 1.5s. Increase `RUNS_PER_SECOND` to the production peak plus 50% and archive the k6 JSON summary before a major release.

## Browser suite

`npm run test:e2e` covers anonymous access and enterprise sign-in in Chromium, Firefox, and WebKit. With `E2E_API_KEY`, it also proves workflow JSON import/export/delete against the configured environment. CI retains traces and screenshots on failures.

## Identity and lifecycle

Supabase SSO supplies SAML/OIDC identity federation; verified DNS domain claims gate workspace SSO enforcement. SCIM bearer tokens are shown once and stored only as hashes. Workspace MFA requires AAL2. Customer export is streaming NDJSON and includes stored-file bytes while omitting credential material. Account and workspace deletion require explicit confirmation and delete database, graph, file-storage, and connector-owned state through the teardown services.
