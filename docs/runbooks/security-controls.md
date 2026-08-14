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
2. Watch browser consoles and Sentry for `Refused to …` reports for a full
   release cycle, exercising the flow builder, huddle, integrations and MCP
   screens — those pull in the most third-party client code.
3. Unset `CSP_REPORT_ONLY` to enforce.

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

Enabling every table at once is what caused the three outages: it moves every
query onto the transaction path at the same moment, and against a pgbouncer
transaction pooler with `connection_limit=1` that is a different concurrency
profile than the app was load-tested under.

`DATABASE_RLS_ENABLED` accepts:

| Value | Meaning |
| --- | --- |
| unset / `false` | Off. The app-layer tenant guard is the only boundary. |
| `Model,Model2` | Exactly these Prisma models. **The staged path.** |
| `true` | Every org-scoped model. Correct end state, bad first step. |

Names are Prisma model names from `ORG_SCOPED_MODELS`
([`src/lib/tenant-guard.ts`](../../src/lib/tenant-guard.ts)) — `FlowRun`, not
`flow_runs`. An unknown name throws at boot rather than silently protecting
nothing.

### Procedure

1. In **staging**, set `DATABASE_RLS_ENABLED` to two or three low-traffic models.
   Confirm `DATABASE_URL` uses the non-owner, non-`BYPASSRLS` application role
   and `SYSTEM_DATABASE_URL` the privileged one.
2. Load-test. Watch **pool checkout time and connection saturation**, not just
   error rate — the outages were a connection-exhaustion signature, not a policy
   failure.
3. Promote that same set to production. Hold for a full traffic cycle.
4. Repeat with the next few models. Roll back by removing a model from the list —
   one table, not all of them.
5. Once the list covers `ORG_SCOPED_MODELS`, replace it with `true`.

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
