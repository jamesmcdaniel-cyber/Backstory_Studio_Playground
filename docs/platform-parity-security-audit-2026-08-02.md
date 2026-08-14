# Platform parity and security audit — 2026-08-02

## Executive result

Backstory Studio's **core product is a real, end-to-end automation platform**, not
a UI prototype. Agents, flows, triggers, HTTP, connected integrations, MCP,
templates, versioning, collaboration, execution history, approvals, audit,
notifications, knowledge retrieval, and worker operations all have persisted
server implementations and automated coverage.

The project is **core-platform complete, but not fully commercial/enterprise
complete**. Self-service billing is explicitly a placeholder. Enterprise identity
lifecycle, user/workspace data export and deletion, database row-level security,
native workflow import, and proven backup/restore and production load behavior are
not present. These are called out below rather than being counted as complete.

Security result after this audit: **no known critical or high application defect
remains in the paths reviewed**, and `npm audit` reports zero known dependency
vulnerabilities. Residual risks are principally defense-in-depth and operational:
database RLS, full parent-page CSP, encryption-key rotation, production environment
verification, load testing, and disaster-recovery exercises.

This was a source, configuration, schema, test, and dependency audit. It was not a
live penetration test against a deployed environment or third-party accounts.

## Product parity matrix

| Capability | Status | Evidence / boundary |
| --- | --- | --- |
| Authentication and workspace bootstrap | Complete for standard SaaS | Supabase session verification, company-domain enforcement, password/Google flows, invite acceptance, workspace provisioning |
| Workspace membership and authorization | Complete for fixed roles | Viewer/member/admin/owner bundles, route-level permission declarations, invitations, role change/removal; custom roles are not supported |
| Agents | Complete | Create/edit, AI draft/chat, manual/scheduled/webhook/signal execution, memory, knowledge, activity, replies, cancellation, trigger-secret rotation |
| Flow authoring | Complete | Canvas and inline editing, rich node catalogue, branching/loops/parallel/merge/wait/subflows, variables, code, pinned data, copilot, validation |
| Flow triggers | Complete | Manual, schedule/cron/once, signed webhook, signal/provider event, polling, subflow, and error-flow behavior |
| HTTP automation | Complete | Methods, query/header/body modes, saved auth, cURL import, redirects, retries, timeouts, pagination, files, response parsing, SSRF protection |
| Integration nodes | Complete | Nango catalogue/connect/session/mirror/proxy, per-workspace Slack/email/Granola credentials, provider signals |
| MCP nodes | Complete | Discovery, API-key/OAuth client credentials/OAuth authorization code, encrypted secrets, refresh, verification, tool catalogue and execution |
| Execution operations | Complete | Queue/inline modes, worker pool, pinned manifests, run/step history, retry, cancellation, dead letters, waits/resume, idempotency, retention |
| Templates | Complete for current product | Built-in templates work without stored rows; org/community catalogue, use, author, version/restore, proposal/review/publish/takedown |
| Flow settings and history | Complete | Persisted settings, immutable edit snapshots, named version history, restore, publish snapshot; see `flows-n8n-parity-audit.md` |
| Collaboration | Complete | Collaborators, role links, explicit anonymous public view, realtime presence/cursors, graph sync, voice huddle and retained summaries |
| Governance | Complete for fixed-role SaaS | Human approvals, action audit records, CSV audit export, catalogue review controls |
| Notifications | Complete | In-app notifications, unread state and optional browser push |
| Knowledge and search | Complete with optional infrastructure | File ingestion/extraction, RAG indexing/retrieval, workspace search, Neo4j/Voyage optional degradation |
| Observability and health | Substantially complete | Structured logging, Sentry hook, readiness probe, queue dead-letter capture; no product metrics/SLO dashboard in repo |
| Billing and plan administration | **Not complete** | Settings says self-serve upgrades are unavailable; no checkout, subscription webhook, invoice/seat management, or entitlement sync |
| Enterprise IAM | **Not complete** | No SAML/SSO administration, SCIM provisioning/deprovisioning, domain claim, or workspace MFA policy |
| Privacy lifecycle | **Not complete** | Audit CSV exists, but no user/workspace full-data export, account deletion, workspace deletion, or admin retention controls |
| Portability and developer platform | Partial | n8n and instruction export plus cURL import exist; no native full-flow JSON import, customer API keys, documented public API, CLI, or SDK |
| Resilience proof | **Not verified** | Retention/reapers and horizontal workers exist; no committed backup/restore runbook or restore drill, browser E2E suite, or current 100-user load result |

## Security findings remediated in this audit

### S-01 — incomplete tenant guard coverage — high — fixed

`Invitation`, `FlowTemplate`, `FlowTemplateVersion`, `HuddleSegment`, and
`HuddleNote` are required-tenant models but were absent from `ORG_SCOPED_MODELS`.
The guard now covers every Prisma model with a required `organizationId`. A new
schema-derived test makes future omissions fail automatically.

Legitimate pre-auth invitation-token lookups now use the explicitly unguarded
system client with justification. Authenticated writes retain the resolved
destination `organizationId`.

### S-02 — huddle note cross-tenant lookup — high — fixed

Summary idempotency and race recovery queried a globally unique `sessionId` without
tenant or flow scope. Both reads now require `sessionId`, `flowId`, and
`organizationId`.

### S-03 — OAuth/auth open redirects and state integrity — high — fixed

People.ai accepted an arbitrary `return_to`, and the primary auth callback's local
check did not reject backslash/control-character URL variants. Both now use the
same-origin path validator at the input and redirect sink.

The People.ai state/PKCE cookie is now authenticated encryption rather than plain
JSON, carries user and organization identity, and the callback binds both values to
the current session before exchanging the code.

### S-04 — passive model-output data exfiltration — high — fixed

A script-less iframe sandbox still permits remote images and styles to make network
requests. Prompt-injected output could encode private context in a URL and exfiltrate
it when rendered. HTML previews now receive a restrictive, first-position CSP
(`default-src 'none'`, network images blocked). Markdown only auto-loads local,
data-raster, or blob images; external images require an explicit click.

### S-05 — unbounded outbound response buffering — medium — fixed

Flow HTTP text/file downloads and the agent HTTP tool used `text()` or
`arrayBuffer()`, which buffers an entire peer-controlled response before later
truncation/validation. Shared streaming readers now enforce byte limits while
reading and reject oversized declared or chunked bodies. Flow files are bounded to
the existing 10 MB storage limit and ordinary HTTP output to 1 MB.

### S-06 — invitation preview load abuse — low — fixed

The public invitation preview performed an unlimited database lookup. It now clamps
token length and applies a fail-closed per-client request budget.

## Existing controls verified

- Every API route is either wrapped in authenticated authorization or appears in an
  explicit, tested exception registry for HMAC, trigger token, cron secret, OAuth
  callback, or public readiness behavior.
- Every wrapped route declares a permission; writes receive a global wrapper-level
  rate limit when shared Redis is configured.
- Secrets use AES-256-GCM in production; webhook/trigger tokens use hashes and
  constant-time comparisons. Production refuses to encrypt without
  `ENCRYPTION_KEY`.
- User-provided outbound HTTP/MCP targets require public HTTPS DNS results, are
  rechecked on use, reject unsafe redirects, and strip credentials on cross-origin
  redirect hops.
- Flow webhook bodies are size-limited, signed, timestamp-windowed, and deduplicated
  when replay protection is enabled. Cron routes fail closed and compare secrets in
  constant time.
- Uploads are size/quota bounded, MIME-sniffed, tenant-scoped, attachment-served, and
  malware scanning is mandatory in production.
- JavaScript flow code runs in a permission-restricted child process and isolated VM;
  Python is isolated, AST-gated, builtin-limited, time-limited, and memory-capped on
  supported hosts.
- Security headers include HSTS, frame denial, MIME sniffing denial, referrer and
  permissions policies, and a baseline CSP.
- Production and full dependency audits both report zero known vulnerabilities as
  of the audit date.

## Residual security and operational risk

> **Update 2026-08-13.** The rows marked ✅ below were closed in the hardening
> pass of that date. Operational procedures for the new controls are in
> [`runbooks/security-controls.md`](runbooks/security-controls.md).

| Priority | Residual item | Required action |
| --- | --- | --- |
| P1 | ✅ No PostgreSQL row-level security — **mechanism closed, rollout pending** | RLS is built and now stages per-model via `DATABASE_RLS_ENABLED` (`src/lib/authz/rls-rollout.ts`) instead of the all-at-once boolean that caused three outages. Enabling it in production remains an ops task; follow the runbook |
| P1 | Production configuration is not proven by source | Verify Redis is shared, worker/web use the same queue, `CRON_SECRET`, scanner, encryption key, provider keys, Sentry, webhook replay protection, and separate DB pool limits in deployed environments |
| P1 | Backup/restore and incident recovery are unproven | Define RPO/RTO, automate backups, run a restore drill, document secret rotation and worker/queue recovery |
| P2 | ✅ Parent-page CSP has no script/style source restrictions | Closed. Per-request nonce + `script-src 'strict-dynamic'` built in `src/lib/security/csp.ts`, attached in `src/middleware.ts`, ships behind `CSP_REPORT_ONLY`. Required forcing dynamic rendering app-wide — a static page carries no nonce. Verified in a real browser against a production build (`e2e/csp.spec.ts`) |
| P2 | ✅ Encryption format has no key id/rotation ring | Closed. `v2:<keyId>:…` format with a dual-read key ring (`ENCRYPTION_KEY_PREVIOUS`) and `npm run secrets:rotate`. A new encrypted column fails `sensitive-columns.test.ts` until it is added to the rotation script |
| P2 | Anonymous flow share tokens are plaintext bearer values in the DB | Consider a hashed lookup token or separately stored digest; continue treating URLs and DB access as credential-bearing |
| P2 | No automated browser E2E/security journey | Add authenticated Playwright journeys for invite, template-use, flow publish/trigger, integration/MCP selection, history restore, approvals, and cross-role access |
| P2 | DNS rebinding is narrowed, not eliminated | For the highest-risk outbound calls, pin the validated IP through connection establishment or use an egress proxy with network policy |

## Launch decisions and necessary additions

Before calling the product universally “fully built,” decide its launch tier:

1. **Internal/beta platform:** the implemented core is sufficient after deployed
   environment verification, a real end-to-end integration run, and backup/restore
   proof.
2. **Commercial self-service SaaS:** add subscription checkout/portal, webhook-driven
   plan enforcement, seat/usage metering, invoices, cancellation/dunning, tax/legal
   ownership, and support escalation.
3. **Enterprise SaaS:** additionally add SAML/OIDC workspace SSO, SCIM, domain claim,
   MFA/session policy, custom roles or scoped grants, admin security logs, and data
   residency/retention controls.
4. **External customer/data-processing launch:** add full data export and deletion,
   workspace teardown UI, retention controls, subprocessors/consent workflow, and a
   documented privacy request process.

## Verification record

- `npm audit --omit=dev --audit-level=moderate` — 0 vulnerabilities
- `npm audit --audit-level=moderate` — 0 vulnerabilities
- Focused tenant, route-auth, HTTP-body, OAuth service, HTML/Markdown security, and
  flow HTTP tests — passed (DB-dependent test skipped when no `TEST_DATABASE_URL`)
- `npm run typecheck` — passed
- `npm test` — 1,521 passed, 0 failed, 6 skipped (environment-dependent suites)
- `npm run lint` — 0 errors, 9 pre-existing warnings
- `next build` with non-secret Supabase build placeholders — passed; emitted the
  existing Supabase dynamic-require and optional BullMQ Valkey-module warnings
- Largest client entry is the flow builder (705 kB first load in this build); bundle
  splitting the builder is a P2 performance follow-up before broad low-bandwidth use

## Hardening pass — 2026-08-13

Closed against a 20-point application-security checklist. Full detail in
[`runbooks/security-controls.md`](runbooks/security-controls.md).

### H-01 — published anon key had unrevoked table privileges — high — fixed

`NEXT_PUBLIC_SUPABASE_ANON_KEY` ships in the browser bundle by design, but no
migration had ever revoked the `anon` / `authenticated` grants that Supabase's
project defaults apply to objects created in `public` — and Prisma creates every
table there. With RLS off there were no row policies behind those grants, so the
published key was potentially a full cross-tenant read over PostgREST.
Migration `20260813120000_revoke_postgrest_grants` revokes them and the default
privileges that would re-grant them on the next `migrate deploy`. Safe because
the Supabase client is used for Auth and Realtime only — there is no
`supabase.from(...)` anywhere in `src/`.

### H-02 — session cookie readable by scripts with no script-src — high — fixed

The Supabase session cookie omits `httpOnly` (the browser client reads it via
`document.cookie`), and `src/lib/supabase/config.ts` documented CSP as the
compensating control. That control did not exist: the shipped policy set
`frame-ancestors`, `base-uri` and `object-src` and left `script-src` unset, so
any XSS could read the access **and** refresh token. Now a per-request nonce with
`'strict-dynamic'`.

Separately, the **browser** client was constructed without `SUPABASE_COOKIE_OPTIONS`
at all, so every token refresh rewrote the session cookie with library defaults —
no `secure`, no `sameSite` — overwriting the server's flags. Fixed in
`src/lib/supabase/client.ts`.

### H-03 — unbounded request bodies on mutating routes — medium — fixed

`withAuthenticatedApi` enforced auth, permission and rate limit but no body size.
Routes taking free-form JSON by design (signal payload, resume payload, agent
trigger input) had no ceiling. Now a wrapper-level `content-length` check
(`API_MAX_BODY_BYTES`, default 4 MB), checked before session work, with explicit
higher ceilings on the three multipart upload routes.

### H-04 — dependency updates were never proposed — low — fixed

CI audited dependencies but nothing opened update PRs, so a CVE was discovered
only when a gate broke. Added Dependabot (npm + GitHub Actions), tightened the
production audit gate from `high` to `moderate`, and added a non-blocking dev
dependency audit for the build-chain supply-chain surface.

### Assessed and found already sound

Parameterized queries (all raw SQL is tagged-template or static-literal, with an
existing guard test), output escaping (no `dangerouslySetInnerHTML`, no
`innerHTML`, no `rehype-raw`; agent HTML is isolated in a script-less sandboxed
iframe behind `default-src 'none'`), password hashing (delegated to Supabase),
HTTPS/HSTS, git secret scanning (gitleaks over full history), and server-side
authorization.

Input validation was **better than a file-level `zod` count suggests**: of 138
route files, only three read a body without a schema, and in all three the
payload is free-form by design — the real exposure there was size, not shape
(H-03).

### Scope correction

An earlier reading of this checklist described login rate limiting and bot
protection as open gaps against a password sign-in form. There is no password
form: `signIn`, `signUp` and `resetPassword` exist on the Supabase provider
context with **zero callers**, and sign-in is Google OAuth and SSO only. The
residual exposure is that Supabase's password endpoints stay reachable with the
published anon key for any account that has acquired a password through the
admin-initiated recovery flow. The effective control is Supabase-side CAPTCHA
(a dashboard setting, since those requests never touch this app); the client
plumbing and an enforcing guard test are in place so password auth cannot be
reintroduced without it.
