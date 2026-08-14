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
