# QA and parity closure — operator actions required (updated 2026-08-28)

These items from the QA audit cannot be closed from a code session. Each is
ready to execute: the supporting code, tooling, and docs shipped with the
repository closure work. None is a missing repository implementation; each
requires a deployed environment, customer/provider identity, or secret the
repository must not manufacture.

## Deploy the 2026-08-27 closure
- [ ] Apply migrations `20260827120000_data_tables` through `20260828120000_content_repository` in staging, smoke Data Tables, the Content Repository, external secrets, dynamic credential bindings, execution annotations, flow reviews, and audit-stream settings, then promote the same migration history to production.
- [ ] Deploy the updated web and worker artifacts together. The new universal item contract, graph schema v2, trace propagation, credential resolver, and external-secret resolution span both processes.

## Content Repository
- [ ] Confirm `FILE_SCAN_URL` is configured and healthy in staging and production. Production uploads fail closed when malware scanning is unavailable.
- [ ] In staging, upload a PDF or DOCX from `/data-tables`, download the retained original, edit its indexed text, and verify the new version is retrieved by an in-scope agent.
- [ ] Disable that file, run the same agent query again, and confirm the execution records no passage from the disabled document; re-enable it and confirm retrieval resumes.
- [ ] Pull one read-only action from a connected source, verify a dated pull artifact and redacted provenance appear in the repository, then force one provider failure and verify a disabled failure-history artifact is retained without credential material.

## External secret managers
- [ ] Create least-privilege runtime identities for every configured AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, or Vault connection. Restrict each identity and each Backstory provider row to the smallest usable path/project/vault scope.
- [ ] Run each provider's verify action in staging, resolve one referenced HTTP credential through a real flow run, and confirm the credential-use audit event contains provider/reference metadata but no secret value.

## OpenTelemetry
- [ ] Set an OTLP/HTTP endpoint (and auth header when required) on both web and worker deployments, choose an explicit sampler, and confirm one queued flow produces a connected dispatch/execution span tree in the collector.

## Public SDK
- [ ] If external developers should consume `@backstory/sdk`, choose the registry/access policy, publish the built package, and run the README example against a staging API key. Keeping it workspace-local requires no action.

## Monitoring (minutes, do first)
- [ ] Set the `HEALTH_MONITOR_URL` GitHub Actions secret to `https://<prod-host>/api/health` so `.github/workflows/health-monitor.yml` starts alerting (it runs every 10 minutes and opens/closes a "Production health check failing" issue). Optionally also subscribe an external monitor (UptimeRobot/Better Stack) to the same URL — status code alone is enough; no token needed.
- [ ] Set `SENTRY_DSN` on the Fly worker (`fly secrets set SENTRY_DSN=...`) and confirm it is set in Vercel Production. Until then worker crashes and dead-letter events are console-only.

## Huddle voice TURN (two env vars)
- [ ] Mint a Cloudflare Calls TURN key and set the two Cloudflare vars (exact names now documented in `.env.example`; procedure in `docs/voice-relay-setup.md`) in Vercel Production.
- [ ] Verify: `GET /api/flows/huddle-ice` returns `provider: "cloudflare"`, `relayAvailable: true`.

## RLS staged rollout (the deliberate, staging-first redo)
- [ ] Provision the non-owner login role and set `SYSTEM_DATABASE_URL` + `DATABASE_URL` split in the staging project (checklist added to `docs/runbooks/security-controls.md`).
- [ ] Stage 2–3 models via `DATABASE_RLS_ENABLED=<Model,Model2>` in staging; run `npm run rls:probe`; widen per the runbook. Prod enable only after staging soak.

## Prod configuration proof
- [ ] `fly deploy --config fly.worker.toml` — REQUIRED: `runtime.ts` and `agent-schedule-registrar.ts` both changed this session, and the old image keeps running until you deploy. Then `fly scale count 2` per the runbook.
- [ ] Verify Render `numInstances: 3` and worker `connection_limit` against `render.yaml` declarations in the consoles.

## Secrets hygiene
- [ ] Confirm every secret in `.env.worker.prod` exists in `fly secrets list`, then delete the local file (it duplicates prod credentials unencrypted on this laptop).
- [ ] Revoke the stale `KLAVIS_API_KEY` (Klavis→Nango migration completed 2026-07-15) and remove it from `.env.local`.

## Load test
- [ ] Run `npm run load:platform` (k6, 100 concurrent sessions) against a staging deploy and archive the summary in `docs/` — the infra audit's Wave 4 sign-off depends on it. Do not run against prod without a window.

## Data backfill (ordering constraint)
- [ ] `npm run embeddings:backfill -- --dry-run`, review counts and cost, then `npm run embeddings:backfill`. Covers KnowledgeChunk and AgentMemory; converts valid legacy vectors for free and only re-embeds what it must. Re-run the dry run to confirm 0 remaining. Only after that may the legacy `embedding Json?` columns be dropped — the drop migration was deliberately NOT shipped, since dropping before the backfill loses data.

## Owner account
- [ ] Owner TOTP enrollment (from the 2026-08-14 lockout fix) — enroll at `/auth/mfa` if not yet done.

## Authenticated e2e (new this session)
- [ ] Set the CI secrets so the authenticated journeys actually run: `E2E_BASE_URL`, `E2E_USER_EMAIL`, `E2E_USER_PASSWORD`, `E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`; optionally `E2E_DATABASE_URL` (the free-tier journey skips without it). Until then the job warns and skips rather than passing silently.
- [ ] The test account must be admitted by `isAllowedEmail`, be a workspace admin, and must NOT be a platform owner (owner bootstrap forces MFA, and a password grant is aal1 → every route 403s) or a super admin (exempt actors can never trigger the free-tier refusal). If the Supabase project enforces Turnstile, add a Turnstile *testing* key.
- [ ] Add a staging-only external-secret provider identity and OTLP collector to the authenticated CI environment so live provider resolution and cross-process trace propagation can run outside the mocked unit suite.

## Verify the RLS migration in staging first
- [ ] Migration `20260818130000_rls_teams_grants_idps_tokens` adds policies to four tables plus `team_members`. They are inert while `DATABASE_RLS_ENABLED` is off, and prod's role bypasses RLS exactly as it does for the 40 tables already carrying these policies — but apply it to staging and smoke the teams/SSO/API-token surfaces before prod.
- [ ] Migration `20260827160000_rls_flow_reviews_audit_streams` enables and forces tenant RLS on `flow_reviews` and `audit_stream_destinations`; verify both with the non-owner staging role before promotion.

## Known product boundaries, deliberately not built
- Legacy `embedding Json?` column drop (blocked on the backfill above).
- SFU for huddles >~6, flow-builder reducer, and template ratings/forking: prior scope-outs, unchanged. Binary item metadata and durable references now exist; storage backend selection remains deployment policy, not a per-workflow promise.
- The IdP redirect leg of sign-in cannot be automated in e2e; it stays a manual check.
- Three catalogue integration labels (`nango:snowflake`, `CRM`, `Calendar`) match no connector and render an unsatisfiable "Requires" chip. Pinned by a test so the set can only shrink — it needs a data decision from you.
- Exact n8n node/credential catalogue equivalence, arbitrary community packages, unrestricted JavaScript expressions, shell/local-filesystem/Computer Use, Git environment sync, LDAP, an OAuth authorization server, Quick Connect, and multi-instance registry are not Backstory architecture gaps. They require separate product decisions before implementation.
