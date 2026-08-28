# Security controls runbook

Operational procedures for the controls added in the 2026-08-13 hardening pass.
Each section names the thing that breaks if the steps are done out of order.

## 1. Content-Security-Policy rollout

The policy is built per-request in [`src/lib/security/csp.ts`](../../src/lib/security/csp.ts)
and attached in [`src/middleware.ts`](../../src/middleware.ts).

**Why it matters more than a usual CSP:** the Supabase session cookie has no
`httpOnly` flag — the browser client reads it from `document.cookie` — so
`script-src` is the only thing between an XSS and a stolen access + refresh
token. Weakening it (adding `'unsafe-inline'`, a wildcard host, or a second
static policy in `next.config.js`) re-opens that path.

### Rolling it out

1. Deploy with `CSP_REPORT_ONLY=true`. The browser sends
   `Content-Security-Policy-Report-Only`: violations are reported, nothing is
   blocked.
2. Watch the logs for `CSP violation reported`. Reports are collected by
   [`/api/csp-report`](../../src/app/api/csp-report/route.ts) and logged at
   `warn` with the directive, blocked URI, document URI and a 100-character
   script sample. Give it a full release cycle, and exercise the flow builder,
   huddle, integrations and MCP screens — those pull in the most third-party
   client code.
3. Triage each distinct directive/blocked-URI pair. Add legitimate origins to
   `buildContentSecurityPolicy`; anything unexplained is the finding the
   report-only period exists to surface.
4. Unset `CSP_REPORT_ONLY` to enforce.

The collector is deliberately unauthenticated — a browser posts reports with no
credentials, and a violation can fire on a page whose session is exactly what
broke. It carries no authority (it only writes a log line) and is rate limited
fail-closed per client, size capped at 16 KB, and never echoes input back. It
answers `204` to everything including malformed bodies: a collector that errors
gets retried by the browser.

The policy carries **both** `report-uri` and `report-to`. `report-uri` is
deprecated but is what Safari and older Chrome/Firefox actually send, so shipping
only the modern directive would collect nothing from a large share of real
browsers. `report-to` additionally needs the `Reporting-Endpoints` response
header, set alongside the policy in `src/middleware.ts`; without it the browser
silently drops the report.

### Adding a new external origin

Add it to the relevant directive in `buildContentSecurityPolicy` — never as a
wildcard. Supabase and Sentry origins are derived from their configured URLs for
this reason: `*.supabase.co` would admit every Supabase project on the internet
as a script source.

### Do not re-enable static prerendering

`export const dynamic = 'force-dynamic'` in [`src/app/layout.tsx`](../../src/app/layout.tsx)
is load-bearing. A statically prerendered page is built before any request
exists, so it carries no nonce, and Chrome refuses its inline scripts — the page
renders blank. Verified during rollout: static routes served 0 nonces while
dynamic routes served theirs correctly. `e2e/csp.spec.ts` catches a regression.

## 2. Encryption key rotation

Format and key ring: [`src/lib/crypto/secrets.ts`](../../src/lib/crypto/secrets.ts).
Payloads are `v2:<keyId>:<iv>:<tag>:<ciphertext>`; the key id is a digest of the
derived key, never key material.

1. **Both keys live.** Set `ENCRYPTION_KEY` to the new key and
   `ENCRYPTION_KEY_PREVIOUS` to the outgoing one. Deploy. Reads work against
   either; every new write uses the new key.
2. **Dry run.** `npm run secrets:rotate -- --dry-run`. This decrypts and
   re-encrypts in memory, writing nothing, so it proves every payload is
   readable *before* anything changes. Do not continue while it reports failures.
3. **Rotate.** `npm run secrets:rotate`. Idempotent and per-row — an interrupted
   run is resumed by running it again.
4. **Confirm.** Re-run until it reports `0` remaining.
5. **Retire.** Only now unset `ENCRYPTION_KEY_PREVIOUS`.

Unsetting `ENCRYPTION_KEY_PREVIOUS` before step 4 reports zero strands those
rows: they name a key id the process no longer holds, and `decryptSecret` throws
naming the missing id.

**Adding a new encrypted column?** Add it to `scripts/rotate-encryption-key.ts`
and classify it in `src/lib/__tests__/sensitive-columns.test.ts`. That test fails
until you do, precisely so a column cannot be added and then stranded on the next
rotation.

## 3. Row-level security, staged

Resolver: [`src/lib/authz/rls-rollout.ts`](../../src/lib/authz/rls-rollout.ts).

### What testing against a real database found

The rollout was validated against PostgreSQL 18 with the full migration history
and a real non-owner (`NOBYPASSRLS`) role. Three defects surfaced that no
TypeScript-level test could see. All are fixed; the procedure below assumes those
fixes are deployed.

**1. `flow_side_effects` had no RLS at all.** It was created nine days after the
RLS migration enumerated its tenant tables by hand, so it shipped as a
required-`organizationId` model with row security disabled — the guard set the
tenant context and PostgreSQL enforced nothing. Fixed by migration
`20260813150000_rls_flow_side_effects`.

**2. Five parent-scoped tables returned zero rows, silently.**
`flow_run_steps`, `flow_collaborators`, `execution_messages`, `workflow_steps`
and `workflow_events` have no `organizationId` of their own; their policies
resolve tenancy through a parent via `EXISTS (… AND r."organizationId" =
nullif(current_setting('app.organization_id', true), '')::uuid)`. With the
setting unset that comparison is NULL, so the `EXISTS` is false and **PostgreSQL
returns no rows and no error** — run history and step output look deleted.
Because these models are absent from `ORG_SCOPED_MODELS`, nothing set the value
for them. Measured: `flow_run_steps` returned 0 rows without the setting and 1
with it. They are now declared in `RLS_PARENT_SCOPED_MODELS` and the guard throws
rather than serving an empty result.

**3. Staging a single model emptied every model that was not staged.** The
guarded client was built on the non-owner connection, so naming one model in
`DATABASE_RLS_ENABLED` moved *all* queries onto the RLS-enforcing role while only
that model received tenant context. Measured: with `DATABASE_RLS_ENABLED=Flow`,
`Flow.findMany` returned 1 row and `FlowRun.findMany` returned 0 for the same
tenant. This made the staged path strictly more dangerous than the boolean it
replaced. The guarded client is now built on `systemPrisma`, so unstaged models
keep the owner connection they had before the rollout began.
`src/lib/__tests__/rls-staged-rollout.db.test.ts` fails if this regresses.

### How the flag behaves

`DATABASE_RLS_ENABLED` controls **both** the connection role and the tenant
context, and they cannot drift apart: with the flag off the app uses the owner
connection (which bypasses RLS), and the non-owner role is only reached for
models the flag names. There is no configuration that puts the app on the
enforcing role without also setting tenant context for the models it enforces.

| Value | Meaning |
| --- | --- |
| unset / `false` | Off. The app-layer tenant guard is the only boundary. |
| `Model,Model2` | Exactly these Prisma models. **The staged path.** |
| `true` | Every org-scoped model. Correct end state. |

Names are Prisma model names from `ORG_SCOPED_MODELS`
([`src/lib/tenant-guard.ts`](../../src/lib/tenant-guard.ts)) — `FlowRun`, not
`flow_runs`. An unknown name throws at boot rather than silently protecting
nothing.

### Procedure

1. Confirm `DATABASE_URL` uses a non-owner, non-`BYPASSRLS` role and
   `SYSTEM_DATABASE_URL` the privileged one. Both are needed before any model is
   staged — the flag switches between them per query.
2. In **staging**, start with two or three low-traffic models. Verify that
   unstaged surfaces still return data (that was defect 3), not just that the
   staged ones do.
3. Load-test. Watch **pool checkout time and connection saturation**, not error
   rate — every staged model's query now takes a transaction, and the original
   outages were a connection-exhaustion signature against a pgbouncer transaction
   pooler at `connection_limit=1`.
4. Promote the same set to production. Hold for a full traffic cycle.
5. Repeat. Roll back by removing a model from the list — one table, not all.
6. When the list covers `ORG_SCOPED_MODELS`, replace it with `true`.

Watch for `RLS context: <Model>.<op> resolves tenancy through its parent row` in
logs during staging. That is defect 2's guard firing: a code path reading a
parent-scoped model outside `tenantTransaction`. It is a bug to fix, and finding
it in staging is the entire reason the guard throws instead of returning `[]`.

### Reproducing the test environment locally

```bash
createdb rls_probe
DATABASE_URL=postgresql://$USER@localhost:5432/rls_probe \
DIRECT_URL=postgresql://$USER@localhost:5432/rls_probe \
  npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://$USER@localhost:5432/rls_probe npm test
```

The DB-backed suites create their own `NOBYPASSRLS` role and skip cleanly if the
database forbids `CREATE ROLE`.

### CI runs the whole DB-backed suite with RLS enforced

The `rls` job in `.github/workflows/ci.yml` applies the migrations as the owner,
provisions a **distinct `NOBYPASSRLS`, non-superuser role**, asserts that role
really is unprivileged (a role that bypasses RLS would make every downstream
assertion pass while enforcing nothing), and then runs every `*.db.test.ts`
against it with `DATABASE_RLS_ENABLED=true`.

This is the difference between "the flag is implemented" and "the flag is known
to work". The main `check` job runs the same suite as the **owner** with the
flag unset — the production configuration, in which every policy in the schema
is inert — so before this job existed the mechanism was exercised only by three
narrow probe cases.

Turning it on found real defects that no TypeScript-level check could see:

- `generateTemplateProposals` established no tenant. It reads `WorkflowStep`, a
  parent-scoped model, so under RLS every workspace's usage profile would have
  come back empty — no error, just a model prompted with "this workspace has no
  tool activity". Its route callers were incidentally covered by the API
  wrapper; the BullMQ worker and the cron sweep were not. It now wraps in
  `ambientOrganization.run`, the fourth such entry point.
- `tenantTransaction` ran its callback without awaiting inside the tenant scope.
  Prisma methods return a **lazy** promise, so a callback of the shape
  `() => prisma.flow.findMany(…)` handed back an unstarted query that executed
  after the scope had closed — and a cross-workspace read that must be rejected
  was served instead. Verified both ways against the real database before and
  after the fix.

`scripts/rls-staging-probe.ts` also now proves enforcement rather than assuming
it. Its original isolation check queried an organization id nothing had ever
been written under, which returns zero rows whether or not PostgreSQL is
enforcing anything. It now seeds a **second tenant that actually has rows** and,
inside a tenant transaction for the first, runs an unfiltered
`SELECT DISTINCT "organizationId" FROM flows` — a question with no tenant
predicate at all, where the policy is the only thing that can exclude the other
tenant's row. That assertion fails if the policies are missing, if RLS is not
`FORCE`d, or if `DATABASE_URL` is a role that bypasses it.

It also pins the limit, so nobody mistakes it for cover: **outside** a tenant
transaction the guard takes the organization from the query's own `where` clause
and sets `app.organization_id` to match, so RLS confirms that answer rather than
refusing it. What keeps that safe is upstream — `withAuthenticatedApi` sources
`organizationId` from the session, never from the request. If that ever changes,
RLS is not the backstop.

### Next steps for the staging redo

The production rollout described above was rolled back to a pre-hardening
commit after three outages; it has not been re-attempted. The application-side
work is now done and continuously verified by the `rls` CI job, so what remains
is **connection sizing**, which is what actually caused the outages and is the
one thing CI cannot measure: every staged model's query takes a transaction, and
against a pgbouncer transaction pooler at `connection_limit=1` that is a
different concurrency profile than the app was load-tested under. Step 3 below
is therefore the load-bearing step, not a formality.

This is the concrete checklist for redoing it in **staging** (never production
first — see "What testing against a real database found" above for why a
TypeScript-only check missed all three defects):

1. **Env vars to set on the staging environment** (see `.env.example` for the
   full comments):
   - `SYSTEM_DATABASE_URL` — the privileged (owner) connection. Required
     before touching `DATABASE_RLS_ENABLED` at all: `src/lib/prisma.ts`
     refuses to boot if RLS is enabled and this is unset.
   - `DATABASE_URL` — must be a distinct non-owner, `NOBYPASSRLS` role once
     any model is staged (it can stay the owner role while
     `DATABASE_RLS_ENABLED` is `false`/unset).
   - `DATABASE_RLS_ENABLED` — start unset (`false`), then move to a short
     comma-separated model list per step 2 below. Never start with `true`.
2. **Probe the exact three defects this rollout is known to hit** before
   staging real traffic, using the fixture the DB test suite itself uses:

   ```bash
   createdb rls_probe   # or point at a disposable staging database
   DATABASE_URL=<staging non-owner role> \
   SYSTEM_DATABASE_URL=<staging owner role> \
   DATABASE_RLS_ENABLED=Flow \
   RLS_PROBE_ORG=<a seeded staging organization id> \
     npx tsx scripts/rls-staging-probe.ts
   ```

   This runs as its own process (module-init caching in `src/lib/prisma.ts`
   means a same-process re-import can't be trusted) and prints one JSON line:
   `stagedOwnTenant` (the staged model returns its own rows — defect-1-style
   regressions show as this being wrong or throwing), `stagedForeignTenant`
   (must be `0` — cross-tenant isolation on the staged model), `unstagedOwnTenant`
   (an org-scoped model NOT in `DATABASE_RLS_ENABLED` — must still return data;
   `0` here is defect 3 recurring), and `parentScopedNoContext` (must read
   `"threw"` — a parent-scoped model queried outside `tenantTransaction` with
   no context; `"returned N"` is defect 2 recurring). Treat anything other
   than `{stagedForeignTenant: 0, unstagedOwnTenant: >0, parentScopedNoContext:
   "threw"}` as a blocker, not a finding to fix later.
3. **Suggested staging model order**: start with 1-2 low-traffic, low-blast-
   radius models with NO parent-scoped dependents (avoid `Flow`/`FlowRun`
   first, since `FlowRunStep` and other `RLS_PARENT_SCOPED_MODELS` resolve
   tenancy through them and would immediately exercise defect 2 under load).
   A model with few or no rows tied to `RLS_PARENT_SCOPED_MODELS` — check
   `src/lib/authz/rls-rollout.ts` for the current parent-scoped list — is the
   safer first step; expand to `Flow`/`FlowRun` only after the parent-scoped
   guard has been observed working under real staging traffic.
4. Only after the probe is clean and a load test against staging shows no
   pool-checkout regression (per step 3 of the Procedure above) does this
   move toward production, following the same staged Procedure.

## 4. PostgREST exposure

Migration `20260813120000_revoke_postgrest_grants` revokes all `anon` /
`authenticated` privileges on the `public` schema and revokes the default
privileges that would re-grant them on the next `prisma migrate deploy`.

This is safe because the Supabase JS client is used for **Auth and Realtime
only** — there is no `supabase.from(...)` call anywhere in `src/`. If that ever
changes, the calling code needs its own grants and row policies; do not blanket
re-grant.

Verify after deploy — this should return no rows:

```sql
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE grantee IN ('anon','authenticated') AND table_schema='public';
```

## 5. Bot protection

Both halves are required, and enabling either alone is worse than neither:

1. Supabase dashboard → Authentication → Attack Protection → enable CAPTCHA,
   provider **Turnstile**, paste the Turnstile **secret** key.
2. Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` to the matching **site** key.

Enabling only (1) rejects every password auth request the app sends. Enabling
only (2) renders a widget that protects nothing.

Supabase — not this app — verifies the token, and that is the point: password
auth runs browser → Supabase directly, so no server-side rate limit in this
codebase is on that request path. See
[`src/lib/auth/captcha.ts`](../../src/lib/auth/captcha.ts).

The product currently has **no password form** — sign-in is Google OAuth and SSO
only. `src/lib/auth/__tests__/password-auth-guard.test.ts` fails if a password
auth call site is added without wiring `useTurnstile()`.

## 6. Attack detection and alerting

Rejections used to be silent. A 401, a 403, a 429 or a bad webhook signature
returned its status and left nothing behind — no log line, no audit row, no
counter — and 4xx never reached Sentry (which by design only receives 5xx). That
made an attack the one class of traffic the platform could not see.

### What is recorded

[`src/lib/security/events.ts`](../../src/lib/security/events.ts) is the single
entry point. Every rejection produces:

1. **A structured log line**, always — `security.<kind>` at WARN. This works
   with no database, no Redis and no email configured, so it is the layer that
   must never be conditional. It is the grep and log-alert-rule anchor.
2. **An audit row** when the actor's organization is known, with
   `action = security.*`. Anonymous 401s have no organization to attach to.
3. **A threshold count**, per subject (user id when known, else IP).

| Kind | Raised by | Alerts at |
|---|---|---|
| `auth.failed` | 401 from `withAuthenticatedApi` | 20 / 5 min |
| `auth.forbidden` | 403 — permission, entitlement, MFA, SSO, API-key scope | 20 / 5 min |
| `auth.token_invalid` | trigger secret, HMAC webhook, SCIM bearer, API key, cron secret | 10 / 5 min |
| `abuse.rate_limited` | 429 from the write budget, the AI guard, or a route limiter | 60 / 5 min |
| `abuse.body_too_large` | 413 from the wrapper's body ceiling | 20 / 5 min |

`auth.forbidden` sits low because a legitimate user does not walk into twenty
permission denials in five minutes — a script enumerating routes does.
`abuse.rate_limited` sits high because a runaway client loop trips it harmlessly
and repeatedly; only sustained pressure is interesting.

### Turning alerts on

```
SECURITY_ALERT_EMAIL=security@yourdomain.com,ops@yourdomain.com
```

That is the only required variable. `RESEND_API_KEY` is already set for
invitation mail and is reused. With `SECURITY_ALERT_EMAIL` unset the system is
log-only — a deliberate no-op, so a fresh clone and every preview deploy run
without it.

Optional: `SECURITY_ALERT_COOLDOWN_MS` (default 1h) is the per-(kind, subject)
silence window. An attack sustained for an hour produces one email per subject
per kind, not one per request — the point is to be told something is happening,
and the audit log holds the detail.

### Investigating an alert

The email names the event kind, the subject, the last path and the last IP.
From there:

```sql
-- everything that subject tripped, most recent first
SELECT "createdAt", action, "resourceId", ip, detail
FROM audit_events
WHERE action LIKE 'security.%'
ORDER BY "createdAt" DESC
LIMIT 200;
```

Anonymous events (no organization) are in the server logs only — filter on
`security.` in the Vercel/Fly log drain.

### Caveat: counting is only global with a shared limiter backend

Thresholds are counted through [`src/lib/ratelimit.ts`](../../src/lib/ratelimit.ts).
With `UPSTASH_REDIS_REST_*` or `REDIS_URL` set the count is global; without one
it falls back to per-instance memory and an attack spread across lambda
instances alerts later than it should. `assertServerEnv()` already refuses to
boot production without one — see [`src/lib/env.ts`](../../src/lib/env.ts).

## 7. Health endpoint detail

`/api/health` returns liveness to anyone and detail only to a token holder. The
`checks` block names queue topology, dead-letter counts, worker heartbeat
freshness and whether secret encryption is configured — a live infrastructure
map that used to be readable by anyone who knew the URL.

The **status code is unchanged for everyone** (200 / 503), so an uptime monitor
needs no credential to learn up-or-down. Only the body narrows.

For the detailed body, send `Authorization: Bearer <token>` where the token is
`HEALTH_DETAIL_TOKEN`, falling back to `CRON_SECRET` — so existing monitors that
already carry the cron secret keep their detailed view with no new
configuration. In development, with neither variable set, detail is open.
