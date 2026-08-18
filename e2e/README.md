# Browser end-to-end suite

Two suites live here, separated by Playwright project.

**Anonymous** (`chromium`, `firefox`, `webkit`) — CSP enforcement, the sign-in
gateway, the public API. Needs nothing but a running app. This is what runs on
every pull request today.

**Authenticated** (`auth setup` → `authenticated` → `authenticated (limits)`) —
the nine product journeys. Needs a real signed-in identity, so it needs
configuration. Without it, every journey reports **skipped with a reason**; none
of them silently pass.

---

## How the session is established

There is no password sign-in form to automate. `/auth/login` offers only
"Continue with Google" and enterprise SAML, both of which hand the browser to a
third party.

So `auth.setup.ts` mints a session where the browser would have minted it — at
Supabase's own token endpoint, with `grant_type=password` — and writes it into
the browser as the cookies `@supabase/ssr` would have written
(`sb-<project-ref>-auth-token`, `base64-` encoded, chunked at 3180 bytes). The
app then verifies it exactly as it verifies a real user's, via
`supabase.auth.getUser()` in the middleware. The setup proves this by calling
`/api/auth/context` and requiring a 200 before saving the storage state.

**Known gap:** the identity-provider redirect itself — clicking "Continue with
Google" and landing on `/auth/callback` with a session — is not covered by any
automated test, and cannot be without automating Google's consent screen.

---

## Environment

### Required for the authenticated journeys

| Variable | What it is |
|---|---|
| `E2E_BASE_URL` | The deployment under test. Without it Playwright starts a local dev server, which needs its own Supabase and database configuration. |
| `E2E_USER_EMAIL` | The test account's email. |
| `E2E_USER_PASSWORD` | Its password — set in the Supabase dashboard; this account is the only one that needs a password at all. |
| `E2E_SUPABASE_URL` | The Supabase project the deployment authenticates against. Falls back to `NEXT_PUBLIC_SUPABASE_URL`. |
| `E2E_SUPABASE_ANON_KEY` | Its anon key. Falls back to `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |

### Optional

| Variable | What it unlocks |
|---|---|
| `E2E_DATABASE_URL` | A direct Postgres URL for the environment under test. Only the free-tier-ceiling journey requires it; it skips loudly without it. Also lets other journeys reset the daily run allowance and tidy up the flows they create. |
| `E2E_CAPTCHA_TOKEN` | Only if the Supabase project has Turnstile CAPTCHA enabled. Prefer a Turnstile **testing** key on the end-to-end project instead. |
| `E2E_API_KEY` | The existing public-API spec. |

### What the test account must look like

- **Admitted by `isAllowedEmail`** — a company domain, a domain in
  `ALLOWED_EMAIL_DOMAINS`, an active `PlatformAllowedDomain` row, or a live
  `PENDING` invitation. Otherwise `resolveAuthUser` returns `accessRevoked` and
  every API call 403s.
- **NOT the platform owner, and not platform staff.** `applyOwnerBootstrap`
  promotes the two hardcoded owner emails to `OWNER`, which forces
  `mfaPolicy = 'required'`; a password-grant session is `aal1` and would be
  refused with `MFA_REQUIRED` on every route.
- **NOT a super admin.** Anyone holding `catalogue.review` bypasses every
  free-tier ceiling, so that journey can never produce its refusal and skips.
- **A workspace admin** (`members.manage`, `integration.manage`) — otherwise the
  invite and credential journeys have no form to drive and skip.
- Its workspace should have `mfaPolicy = 'optional'` (the default).

If the deployment runs with `ENTITLEMENT_GATE` or `BACKSTORY_MCP_GATE` on,
either can 403 the whole session; the setup's failure message names them.

---

## Running

```
E2E_BASE_URL=… E2E_USER_EMAIL=… E2E_USER_PASSWORD=… \
E2E_SUPABASE_URL=… E2E_SUPABASE_ANON_KEY=… \
npx playwright test --project=authenticated --project="authenticated (limits)"
```

The anonymous suite is just `npx playwright test --project=chromium`.

---

## What is stubbed, and why

Every stub is at a network boundary, declared in the spec's header comment.

| Journey | Stub | Why |
|---|---|---|
| Agent run | `POST /api/agents/[id]/execute` | The model call is server-side (`api.anthropic.com` from Next or the worker), so no browser-level interception can reach it. Stubbing also stops every pull request spending model credits. The agent runtime is covered by unit tests and the nightly eval instead. |
| HTTP credential | `POST /api/http-credentials` | The route makes a real outbound request to whatever endpoint the user typed. A journey must not depend on a third-party API being up. |
| App-account connect | `POST /api/nango/session-token` | The next step mounts a `connect.nango.dev` iframe and hands the user to the provider's consent screen. Asserted up to our side of that boundary and no further. |
| Invitation link | `GET /api/invitations/lookup` | Accepting for real calls `transferUserToOrganization`, which would MOVE the test user out of its own workspace and break every later run. The accept transaction is covered by API tests. |

Everything else — flow create, save, run, publish, trigger arming, template
install, member invite, and the free-tier ceiling — runs unstubbed against the
real application and the real database.

---

## Selector fragility

This application has **no `data-testid` attributes in production code**. Every
selector here hangs off an accessible name, a placeholder, or one of the two
structural attributes that exist (`data-node-id` on step cards,
`data-node-configuration` on the inspector root). A copy edit breaks these.
Builder selectors are centralised in `support/builder.ts` so such a break is one
fix rather than nine.
