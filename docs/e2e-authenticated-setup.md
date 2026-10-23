# Signed-in browser journeys: one-time setup

The `Authenticated journeys` job in `.github/workflows/browser-e2e.yml` drives the
real, signed-in app in Chromium: the sidebar and its permission-gated entries,
Integrations → MCP Servers, building/running/deleting a flow, an agent's chat,
Artifacts, Settings, and the older journeys under `e2e/journeys/`. This page is
for the operator who sets that up once, and for anyone who wants to run the
journeys on a laptop.

- On the source repository the job **fails** until the five secrets below are
  set, so the gap stays visible.
- On forks, pull requests from forks, Dependabot pull requests, and the
  `Backstory_customers` mirror it **skips with a notice** (secrets are absent
  there by design).

## How the test account signs in

The app has no password form: `/auth/login` offers Google and SAML only. The
suite therefore mints a session at Supabase's token endpoint
(`grant_type=password`) and writes it into the browser as the
`sb-<project-ref>-auth-token` cookie, which the middleware verifies like any
other session (see `e2e/support/session.ts`).

That requires a password on **one** Supabase user, the test account, and nothing
else:

- **No app setting is needed or changed.** A password is an ordinary Supabase
  Auth credential. Settings → Account can already set one, and Supabase accepts
  the password grant for any user that has a password. People who sign in with
  Google or SAML have none.
- **`AUTH_ALLOW_PASSWORD` stays unset.** It only reopens the `/auth/signup`
  page; the suite does not need that page.
- **Nobody else is admitted.** The provisioning script creates the app's user
  row itself, so the account never passes through domain admission. No
  `PlatformAllowedDomain` row and no `ALLOWED_EMAIL_DOMAINS` entry is added.
- **The account is not privileged.** It is an `ADMIN` of its own workspace only.
  It is never a platform owner or platform staff: those accounts are held to MFA,
  which a password session can never satisfy, and they are exempt from the
  free-tier ceiling that one journey asserts. The script refuses owner and staff
  addresses.

## One-time steps (operator)

Run both steps from a checkout, against the environment the suite will target:
production, or a staging project with its own deployment. CI never runs them.

### 1. Provision the account and its workspace

```sh
SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
DATABASE_URL=<direct Postgres URL for the same environment> \
E2E_USER_EMAIL=e2e-journeys@backstory.ai \
E2E_SUPABASE_ANON_KEY=<anon key> \
npx tsx scripts/e2e/provision-test-account.ts
```

This step does four things:

- It creates the Supabase user, with the email pre-confirmed, a generated
  password, and the stamp `app_metadata.e2e_test_account = true`.
- It creates the workspace **"E2E Journeys (automated test workspace)"**
  (slug `e2e-journeys`, kind `customer`, MFA optional), with that user as its
  only member.
- It checks that the password grant works.
- It prints the secret values. **The password is shown once.** To choose the
  password yourself, pass `E2E_USER_PASSWORD`.

Running it again is safe. It changes nothing unless you pass a password or
`--rotate-password`.

The script refuses in these cases:

- the address is a platform owner or staff address;
- a Supabase user with that email already exists without the e2e stamp (it may
  be a real person);
- an app user with that email exists elsewhere;
- the workspace already holds anyone else;
- the email domain is claimed by a workspace that requires SSO.

If the default address is unsuitable, any address you control works. It does
not need a mailbox, because nothing is ever sent to it.

### 2. Connect the setup gates, as the test account

Production gates the whole app behind a connected Backstory MCP (and, where
`ENTITLEMENT_GATE=on` without native Sales AI mode, a People.ai entitlement).
Satisfy them with a real OAuth grant against the **Keyslogic demo tenant**, so
every journey reads demo data only:

```sh
E2E_BASE_URL=https://<deployment> \
E2E_SUPABASE_URL=https://<project-ref>.supabase.co \
E2E_SUPABASE_ANON_KEY=<anon key> \
E2E_USER_EMAIL=e2e-journeys@backstory.ai \
E2E_USER_PASSWORD=<from step 1> \
npx tsx scripts/e2e/connect-test-account.ts
```

The script opens a browser on `/connect`, signed in as the test account.
Connect the Backstory MCP **with the Keyslogic demo login**, and People.ai too
if the page asks for it. The script exits once `/api/setup/status` reports both
gates ready.

To check readiness later without opening a browser, add `--check`. It exits 0
when the account is ready.

The grant refreshes itself from then on. If the demo tenant's authorization is
ever revoked, the MCP Servers journey fails with that server's error. Re-run
this step to fix it.

### 3. Set the five GitHub secrets

Set them under **Settings → Secrets and variables → Actions** on the source
repository.

| Secret | Where the value comes from |
|---|---|
| `E2E_BASE_URL` | The deployment under test, for example the production URL. It must authenticate against the Supabase project below. |
| `E2E_USER_EMAIL` | The address you provisioned in step 1. |
| `E2E_USER_PASSWORD` | The password step 1 printed, or the one you passed it. |
| `E2E_SUPABASE_URL` | Supabase dashboard → Project Settings → API → Project URL (`https://<ref>.supabase.co`). This is the same value as the deployment's `NEXT_PUBLIC_SUPABASE_URL`. |
| `E2E_SUPABASE_ANON_KEY` | Supabase dashboard → Project Settings → API → `anon` `public` key. This is the same value as the deployment's `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |

Two more secrets are optional:

- `E2E_DATABASE_URL`: a direct Postgres URL. It is needed only by the free-tier
  ceiling journey, which skips with a notice without it. The other journeys
  clean up through the app's API instead.
- `E2E_CAPTCHA_TOKEN`: needed only if the Supabase project enforces Turnstile.
  Prefer a Turnstile testing key on that project.

## What the journeys leave behind

Nothing that accumulates:

- Each journey prefixes what it creates (`E2E …`) and deletes it, through the UI
  where that deletion is the journey, and through the API in a `finally` block
  otherwise.
- Deleting a flow cascades its runs, which also hands the account's daily run
  allowance back.
- The MCP journey restores the tool permission it changed, both through the UI
  and through the API in `finally`.
- The agent chat holds its request in the browser only long enough to assert
  that the run panel opened, then lets it through to the real server. The
  journey passes whether or not that deployment's model keys answer.

## Running locally against a local stack

No Supabase project is needed. `scripts/e2e/local-gotrue-stub.ts` stands in for
Supabase Auth: password grant, `getUser`, refresh, and the admin users API. It
listens on 127.0.0.1 only, keeps users in memory, and derives each user's id
from the email, so a restarted stub hands back the same `supabaseId`.

```sh
# 0. A throwaway database
createdb e2e_local
export DATABASE_URL=postgresql://$USER@127.0.0.1:5432/e2e_local DIRECT_URL=$DATABASE_URL
npx prisma migrate deploy

# 1. The auth stub (leave running)
npx tsx scripts/e2e/local-gotrue-stub.ts            # 127.0.0.1:54329, service key "local-service-role"

# 2. Provision through the stub, exactly as in production. A local stack cannot
#    authorize the Backstory MCP, so add a public no-auth MCP server for the
#    MCP Servers journey to open:
SUPABASE_URL=http://127.0.0.1:54329 SUPABASE_SERVICE_ROLE_KEY=local-service-role \
E2E_SUPABASE_ANON_KEY=local-anon E2E_USER_EMAIL=e2e-journeys@backstory.ai \
E2E_USER_PASSWORD=local-e2e-password-0123456789 \
npx tsx scripts/e2e/provision-test-account.ts --extra-mcp-url https://mcp.deepwiki.com/mcp

# 3. The app (leave running). A fixed heap keeps `next dev` from swapping; it
#    still restarts itself near 80% of it, which only costs a recompile.
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329 NEXT_PUBLIC_SUPABASE_ANON_KEY=local-anon \
ENCRYPTION_KEY=local-e2e-encryption-key-0123456789abcdef \
ENTITLEMENT_GATE=off BACKSTORY_MCP_GATE=on EXECUTION_MODE=inline \
NODE_OPTIONS=--max-old-space-size=8192 npx next dev -p 3100
```

Next, pass the Backstory MCP gate. The app seeds an inactive `provider =
'backstory'` row the first time the account loads, for example on the first
`connect-test-account.ts --check` run. Mark that row authorized with an UPDATE
(it is unique per org, user and provider, so update it rather than insert):

```sql
UPDATE mcp_connections
   SET "isActive" = true, "authConfig" = '{"flow":"authcode","accessToken":"local-placeholder"}'
 WHERE provider = 'backstory'
   AND "organizationId" = (SELECT id FROM organizations WHERE slug = 'e2e-journeys');
```

The gate's readiness answer is cached in memory for 60 seconds per user, so
restart `next dev` (or wait a minute) after the UPDATE.

Then run the journeys:

```sh
E2E_BASE_URL=http://localhost:3100 \
E2E_SUPABASE_URL=http://127.0.0.1:54329 E2E_SUPABASE_ANON_KEY=local-anon \
E2E_USER_EMAIL=e2e-journeys@backstory.ai E2E_USER_PASSWORD=local-e2e-password-0123456789 \
E2E_DATABASE_URL=$DATABASE_URL \
npx playwright test --project=authenticated --project="authenticated (limits)" --workers=2
```

A few things about local runs:

- **Use `localhost`, not `127.0.0.1`, for `E2E_BASE_URL`.** `next dev` builds
  middleware redirects against `localhost`, and the session cookie is set for
  the base URL's host. With `127.0.0.1`, any redirect lands on a host with no
  cookie, and the run shows up as signed out.
- **The cookie is just the session.** Its name is `sb-127-auth-token` (the ref
  is the first label of the Supabase host, so `127`). Its value is
  `'base64-' + base64url(JSON.stringify(session))`. `e2e/support/session.ts`
  builds it, and chunks it past 3180 bytes.
- **Timeouts are longer on local targets.** Against `localhost` the suite also
  warms every surface once in the `auth setup` project, because `next dev`
  compiles each page and API route on its first request.
  `playwright.config.ts` raises the timeouts for local targets only. The
  warm-up takes several minutes on a cold server. When you rerun against a dev
  server that is already warm, skip it with `E2E_WARM_UP=0`.
- **The agent chat journey does not need a model key.** Without one, the reply
  is an error, which the journey accepts.

When you are done, stop `next dev` and the stub, then `dropdb e2e_local`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Supabase password grant failed (400): Invalid login credentials` | Wrong password, or the user was created without one. Re-run step 1 with `--rotate-password`. |
| `… (400): Email logins are disabled` | The project's Email provider is off (Authentication → Providers → Email). Turn it on. With **Allow new users to sign up** off, only users you create can sign in, and only with a password you gave them. |
| `captcha protection: request disallowed` | Turnstile is enforced on the project. Use a Turnstile testing key there, or set `E2E_CAPTCHA_TOKEN`. |
| `/api/auth/context` 403 `MFA_REQUIRED` | The account is privileged, or its workspace requires MFA. Provision an ordinary address. |
| Every page redirects to `/connect` | The Backstory MCP gate is not satisfied. Run step 2. |
| MCP Servers journey: "Every connected MCP server failed to list its tools" | The demo grant was revoked or expired. Re-run step 2. |
