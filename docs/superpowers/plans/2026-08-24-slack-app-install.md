# Slack App Install (Platform-Owned) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace admin clicks "Add to Slack", approves in Slack, and the workspace is connected — no Slack app created by anyone, no token ever handled by a person.

**Architecture:** Two routes implementing OAuth v2 authorization-code against Backstory's own Slack app, following the state-in-an-encrypted-cookie pattern already used by `mcp-connections/oauth/*`. The callback exchanges the code via `oauth.v2.access` and writes the **same** `IntegrationSecret` shape the existing paste path produces, so every downstream consumer is untouched. One security guard is deliberately narrowed: the app-level signing secret (a signature verifier, shared by design) becomes available to customer orgs, while the bot token (a shared *identity*) stays denied.

**Tech Stack:** Next.js App Router, Prisma + PostgreSQL, `node:test` + `node:assert/strict`, Slack OAuth v2.

**Spec:** `docs/superpowers/specs/2026-08-24-slack-teammates-design.md` (layer 0, plus ruling 6)

## Global Constraints

- This is **Plan A of two** from one spec. Plan B (`slack-teammates`) builds mentions on top. Nothing here depends on Plan B.
- The callback must write **exactly** the `authConfig` shape the paste path writes — `mergeAuthConfig(existing, { authType: 'api_key', apiKey: <raw token> })` plus plain `teamId` and `botUserId`. `mergeAuthConfig` encrypts `apiKey` itself; do **not** pre-encrypt it.
- `signingSecret` is **not** written by the install path. Platform-owned installs verify against the app-level `SLACK_SIGNING_SECRET`; only BYO workspaces store their own.
- The bot token env fallback (`SLACK_BOT_TOKEN`) stays gated by org kind. Narrowing applies to the **signing secret only**, and a test must pin that the bot token is still denied to customer orgs.
- `findConflictingSlackOrg` must be checked before writing. With one shared app, two Backstory orgs installing into the same Slack workspace is a realistic mistake, and the failure mode is every delivery silently misrouted.
- New routes must be registered: the callback in `UNGATED_ROUTES` (`src/lib/authz/ungated-routes.ts`) **and** in `readExempt` in `src/app/api/__tests__/route-smoke.test.ts`. The authenticated install route needs a smoke case or a documented skip in the same file. Neither is `internalOnly` — this is a customer-facing surface.
- Bot scopes requested at authorize time, exactly: `app_mentions:read,chat:write,chat:write.customize,channels:history,channels:read`. The last two keep the existing activity backfill working; dropping them would silently break it for installed workspaces.
- DB tests run concurrently against a shared CI-mode database (`ci_repro` locally). Every assertion must be delta-scoped and every suite must clean up its own orgs.
- Run a single test file with: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`

---

### Task 1: Narrow the env-fallback guard for shared app secrets

`resolveOrgCredential` gates the env fallback through `chooseCredential`, which denies **customer** orgs. That is correct for a bot token and wrong for a signing secret — so a customer workspace installing the platform app would fail signature verification with no obvious cause.

**Files:**
- Modify: `src/lib/integrations/org-credential.ts` (add an opt-in flag to `resolveOrgCredential`)
- Modify: `src/lib/integrations/slack.ts:47-56` (`getSlackSigningSecret` opts in)
- Test: `src/lib/integrations/__tests__/shared-app-secret.db.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `resolveOrgCredential({ …, sharedAppSecret?: boolean })` — when true, the env fallback is allowed regardless of org kind.

- [ ] **Step 1: Write the failing test**

Create `src/lib/integrations/__tests__/shared-app-secret.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The signing secret and the bot token are different KINDS of secret, and this
 * suite is what keeps them from being governed by one policy.
 *
 * A shared bot token is a shared IDENTITY — a customer workspace holding it
 * could act as, and read what belongs to, every other workspace on the account.
 * That stays denied.
 *
 * A shared signing secret is the app's SIGNATURE VERIFIER. It proves "Slack
 * sent this, from this app" and grants access to nothing. Every workspace
 * installing the same distributable app is supposed to share it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('shared app secret (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let getSlackSigningSecret: any
  let getSlackToken: any
  let customerOrgId: string
  const previous = {
    signing: process.env.SLACK_SIGNING_SECRET,
    bot: process.env.SLACK_BOT_TOKEN,
  }

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    process.env.SLACK_SIGNING_SECRET = 'app-level-signing-secret'
    process.env.SLACK_BOT_TOKEN = 'xoxb-platform-shared'
    ;({ getSlackSigningSecret, getSlackToken } = await import('@/lib/integrations/slack'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      // kind defaults to 'customer' — the org kind the guard denies.
      data: { name: `slack-shared-${suffix}`, slug: `slack-shared-${suffix}` },
    })
    customerOrgId = org.id
  })

  after(async () => {
    process.env.SLACK_SIGNING_SECRET = previous.signing
    process.env.SLACK_BOT_TOKEN = previous.bot
    await prisma.organization.delete({ where: { id: customerOrgId } }).catch(() => {})
  })

  test('a customer workspace verifies against the app-level signing secret', async () => {
    const resolved = await getSlackSigningSecret(customerOrgId)
    assert.ok(resolved, 'a customer org installing the platform app must be able to verify deliveries')
    assert.equal(resolved.value, 'app-level-signing-secret')
    assert.equal(resolved.source, 'env')
  })

  test('a customer workspace still cannot reach the shared bot token', async () => {
    // The narrowing above must not widen this. A shared bot token is a shared
    // identity; this is the assertion that keeps the two apart.
    assert.equal(await getSlackToken(customerOrgId), null)
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/integrations/__tests__/shared-app-secret.db.test.ts`
Expected: FAIL on the first test — `resolved` is null, because the customer org is denied the env fallback.

- [ ] **Step 3: Add the opt-in flag**

In `src/lib/integrations/org-credential.ts`, extend `resolveOrgCredential`'s params and the env branch:

```ts
export async function resolveOrgCredential(params: {
  organizationId: string
  provider: string
  field?: string
  envValue: string | undefined
  context?: OrgSecretUseContext
  /**
   * Opt in for a secret that is SHARED BY DESIGN across every workspace using
   * Backstory's own app registration — currently only Slack's signing secret.
   *
   * The org-kind gate exists to stop a customer workspace reaching a shared
   * IDENTITY (a bot token, an API key): holding one lets its agents act as,
   * and read what belongs to, every other workspace on that account. A
   * signature verifier is not an identity. It proves a delivery came from our
   * app and grants access to nothing, and a distributable Slack app issues
   * exactly one of them for all installs — so gating it by org kind does not
   * protect anything, it just breaks verification for every customer install.
   *
   * Never set this for a token or key.
   */
  sharedAppSecret?: boolean
}): Promise<ResolvedCredential | null> {
  const orgSecret = await readOrgSecret(params.organizationId, params.provider, params.field, params.context)
  if (orgSecret) return { value: orgSecret, source: 'org' }

  if (!params.envValue) return null

  const organization = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: { kind: true },
  })
  const resolved = params.sharedAppSecret
    ? ({ value: params.envValue, source: 'env' } as const)
    : chooseCredential(null, params.envValue, organization?.kind)
```

Leave the rest of the function — including the `recordCredentialUse` audit on `source === 'env'` — exactly as it is. A shared-app-secret resolution is still a use of a platform credential and still belongs in the audit trail.

- [ ] **Step 4: Opt in from the signing-secret reader only**

In `src/lib/integrations/slack.ts`, update `getSlackSigningSecret` (and its doc comment, which currently says "internal/partner only"):

```ts
/**
 * The workspace's own signing secret, else the app-level one.
 *
 * A BYO workspace that saved its own secret wins. A workspace that installed
 * Backstory's own Slack app has none of its own and verifies against
 * SLACK_SIGNING_SECRET — shared across installs by design, because that is what
 * a distributable Slack app's signing secret IS. See the `sharedAppSecret` doc
 * on resolveOrgCredential for why this is not the shared-identity risk the
 * org-kind gate exists to stop; `getSlackToken` above deliberately does NOT
 * pass it.
 */
export async function getSlackSigningSecret(organizationId: string): Promise<ResolvedCredential | null> {
  return resolveOrgCredential({
    organizationId,
    provider: SLACK_PROVIDER,
    field: 'signingSecret',
    envValue: process.env.SLACK_SIGNING_SECRET,
    sharedAppSecret: true,
    context: { consumer: 'integration.slack.events_receiver' },
  })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/integrations/__tests__/shared-app-secret.db.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Confirm the existing guard suite is unaffected**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/integrations/__tests__/org-credential.test.ts`
Expected: PASS. `chooseCredential` and `envFallbackAllowed` are untouched — the flag bypasses the call rather than changing its policy, so those assertions must all still hold.

- [ ] **Step 7: Commit**

```bash
git add src/lib/integrations/org-credential.ts src/lib/integrations/slack.ts src/lib/integrations/__tests__/shared-app-secret.db.test.ts
git commit -m "fix(slack): let customer workspaces verify against the app-level signing secret

The env-fallback gate denies customer orgs, which is right for a bot
token and wrong for a signing secret. Left alone, every customer
workspace installing Backstory's own Slack app would fail signature
verification with no obvious cause.

A shared bot token is a shared IDENTITY and stays denied. A signing
secret is the app's signature verifier: it proves a delivery came from
our app, grants access to nothing, and a distributable app issues one
for all installs. Narrowed via an explicit sharedAppSecret opt-in that
only the signing-secret reader passes, with a test pinning that the bot
token is still refused.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Install helpers

Pure functions, no I/O, so the URL construction and the token-exchange parsing are testable without network or database.

**Files:**
- Create: `src/lib/slack/install.ts`
- Test: `src/lib/slack/__tests__/install.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces:
  - `SLACK_OAUTH_COOKIE: 'bslack_oauth'`
  - `SLACK_BOT_SCOPES: string`
  - `interface SlackOAuthState { state: string; organizationId: string; userId: string; issuedAt: number; returnTo?: string }`
  - `SLACK_STATE_MAX_AGE_MS: number` (600_000)
  - `stateIsFresh(issuedAt: number, now?: number): boolean`
  - `buildSlackAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string`
  - `parseOAuthAccess(body: unknown): { botToken: string; teamId: string; botUserId: string } | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/install.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SLACK_BOT_SCOPES,
  buildSlackAuthorizeUrl,
  parseOAuthAccess,
  stateIsFresh,
} from '@/lib/slack/install'

test('the authorize URL carries the client id, redirect, state and scopes', () => {
  const url = new URL(
    buildSlackAuthorizeUrl({
      clientId: 'client-123',
      redirectUri: 'https://app.example/api/slack/oauth/callback',
      state: 'state-abc',
    }),
  )
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize')
  assert.equal(url.searchParams.get('client_id'), 'client-123')
  assert.equal(url.searchParams.get('state'), 'state-abc')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example/api/slack/oauth/callback')
  assert.equal(url.searchParams.get('scope'), SLACK_BOT_SCOPES)
})

test('the requested scopes cover mentions, replying as a teammate, and backfill', () => {
  const scopes = SLACK_BOT_SCOPES.split(',')
  // app_mentions:read — without it mentions never arrive at all.
  assert.ok(scopes.includes('app_mentions:read'))
  assert.ok(scopes.includes('chat:write'))
  // chat:write.customize is what lets a reply wear the teammate's own name and
  // avatar. Without it every teammate posts as one undifferentiated bot.
  assert.ok(scopes.includes('chat:write.customize'))
  // Carried over from the BYO scope list: the activity backfill reads history
  // and enumerates channels. Dropping these silently breaks it for installs.
  assert.ok(scopes.includes('channels:history'))
  assert.ok(scopes.includes('channels:read'))
})

test('parseOAuthAccess reads the token, team and bot user from a success body', () => {
  const parsed = parseOAuthAccess({
    ok: true,
    access_token: 'xoxb-real',
    bot_user_id: 'U0BOT',
    team: { id: 'T123', name: 'Acme' },
    scope: SLACK_BOT_SCOPES,
  })
  assert.deepEqual(parsed, { botToken: 'xoxb-real', teamId: 'T123', botUserId: 'U0BOT' })
})

test('stateIsFresh bounds the window server-side and fails closed', () => {
  const now = 1_800_000_000_000
  assert.equal(stateIsFresh(now, now), true)
  assert.equal(stateIsFresh(now - 599_000, now), true)
  assert.equal(stateIsFresh(now - 601_000, now), false)
  // Future-dated and unparseable both fail closed rather than reading as fresh.
  assert.equal(stateIsFresh(now + 5_000, now), false)
  assert.equal(stateIsFresh(Number.NaN, now), false)
  assert.equal(stateIsFresh(undefined as unknown as number, now), false)
})

test('parseOAuthAccess returns null for anything that is not a complete success', () => {
  // Slack answers HTTP 200 even for a rejected exchange, so `ok` is the real
  // result — never the status code.
  assert.equal(parseOAuthAccess({ ok: false, error: 'invalid_code' }), null)
  assert.equal(parseOAuthAccess({ ok: true, bot_user_id: 'U0BOT', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: 'xoxb-real', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: 'xoxb-real', bot_user_id: 'U0BOT' }), null)
  assert.equal(parseOAuthAccess({ ok: true, access_token: '', bot_user_id: 'U0BOT', team: { id: 'T123' } }), null)
  assert.equal(parseOAuthAccess(null), null)
  assert.equal(parseOAuthAccess('nope'), null)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/install.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/install'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/slack/install.ts`:

```ts
/**
 * Backstory's own Slack app — OAuth v2 install helpers.
 *
 * Pure and I/O-free so URL construction and response parsing are testable
 * without a network or a database; the routes do the talking.
 *
 * Why an install flow at all: the BYO model failed operationally. The person
 * who created a workspace's Slack app leaves, nobody can reach its settings,
 * and the workspace has a bot it can neither administer nor replace. Backstory
 * owns one app instead, so no individual's departure can orphan it.
 */

/** Encrypted, httpOnly state cookie — mirrors OAUTH_COOKIE in src/lib/mcp/oauth-authcode.ts. */
export const SLACK_OAUTH_COOKIE = 'bslack_oauth'

/**
 * Bot scopes requested at install.
 *
 *  - app_mentions:read   receive @mentions at all
 *  - chat:write          post the reply
 *  - chat:write.customize  post it under the TEAMMATE's name and avatar; without
 *                          this every teammate looks like one generic bot
 *  - channels:history    conversations.history — the activity backfill's reads
 *  - channels:read       conversations.list — the backfill's channel enumeration
 *
 * The last two carry over from the BYO scope list in
 * docs/runbooks/activity-plane.md §5. Dropping them would leave installed
 * workspaces with a silently broken backfill.
 */
export const SLACK_BOT_SCOPES =
  'app_mentions:read,chat:write,chat:write.customize,channels:history,channels:read'

/** What the encrypted state cookie holds between the two legs of the flow. */
export interface SlackOAuthState {
  state: string
  organizationId: string
  userId: string
  /** Epoch ms the state was minted — see stateIsFresh. */
  issuedAt: number
  returnTo?: string
}

/** Ten minutes to finish consenting. */
export const SLACK_STATE_MAX_AGE_MS = 600_000

/**
 * Is this state still within its window?
 *
 * The cookie carries a maxAge, but that is enforced by the BROWSER — a captured
 * cookie replayed by anything else never sees it. Checking server-side is what
 * actually bounds how long a stolen state is worth stealing. A missing or
 * non-numeric issuedAt fails closed rather than being treated as fresh.
 */
export function stateIsFresh(issuedAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(issuedAt)) return false
  const age = now - issuedAt
  // Future-dated states are refused too: a clock skew large enough to produce
  // one is also large enough to make the age check meaningless.
  return age >= 0 && age <= SLACK_STATE_MAX_AGE_MS
}

export function buildSlackAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('scope', SLACK_BOT_SCOPES)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read an `oauth.v2.access` response.
 *
 * Slack answers HTTP 200 even for a rejected exchange, so `ok` in the body is
 * the real result and the status code is not. All three fields are required:
 * a token with no teamId is unroutable — `findSlackWorkspaceByTeamId` is how an
 * inbound delivery finds its organization — and a missing botUserId breaks
 * `selfOrigin`, which is the loop guard that stops an agent answering itself.
 */
export function parseOAuthAccess(
  body: unknown,
): { botToken: string; teamId: string; botUserId: string } | null {
  const record = asRecord(body)
  if (!record || record.ok !== true) return null

  const botToken = typeof record.access_token === 'string' ? record.access_token : ''
  const botUserId = typeof record.bot_user_id === 'string' ? record.bot_user_id : ''
  const team = asRecord(record.team)
  const teamId = team && typeof team.id === 'string' ? team.id : ''

  if (!botToken || !botUserId || !teamId) return null
  return { botToken, teamId, botUserId }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/install.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/install.ts src/lib/slack/__tests__/install.test.ts
git commit -m "feat(slack): OAuth install helpers for the platform-owned app

Pure URL construction and oauth.v2.access parsing, testable without
network or database.

parseOAuthAccess requires all three of token, teamId and botUserId:
Slack returns HTTP 200 even for a rejected exchange so the body's ok is
the real result, a token without teamId is unroutable, and a missing
botUserId breaks the selfOrigin loop guard.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Install and callback routes

**Files:**
- Create: `src/app/api/slack/install/route.ts`
- Create: `src/app/api/slack/oauth/callback/route.ts`
- Modify: `src/lib/authz/ungated-routes.ts`
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (`readExempt` + a documented skip for the install route)
- Test: `src/app/api/slack/__tests__/install-callback.db.test.ts`

**Interfaces:**
- Consumes: `SLACK_OAUTH_COOKIE`, `SLACK_BOT_SCOPES`, `SlackOAuthState`, `buildSlackAuthorizeUrl`, `parseOAuthAccess` from `@/lib/slack/install`; `findConflictingSlackOrg` from `@/lib/integrations/slack`; `mergeAuthConfig` from `@/lib/crypto/secrets`
- Produces: `GET /api/slack/install`, `GET /api/slack/oauth/callback`

- [ ] **Step 1: Write the failing DB test**

Create `src/app/api/slack/__tests__/install-callback.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The OAuth callback against a real database.
 *
 * The callback is the security boundary of the install: it is unauthenticated
 * by session (Slack is the caller) and authenticated ONLY by the encrypted
 * state cookie. Every negative case below is a way someone could otherwise
 * write a Slack token into a workspace they do not own.
 *
 * Shared CI-mode database — assertions are scoped to orgs this suite creates.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack install callback (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'
  process.env.SLACK_CLIENT_ID = 'client-123'
  process.env.SLACK_CLIENT_SECRET = 'client-secret-123'

  let prisma: any
  let callbackRoute: any
  let encryptSecret: any
  let decryptSecret: any
  let orgA: any
  let orgB: any
  let exchanged: Array<Record<string, string>> = []

  const TEAM = `T${crypto.randomUUID().slice(0, 8)}`

  // Seam: the route talks to Slack through global fetch. Stubbing it keeps the
  // suite offline and lets us assert exactly what was sent to oauth.v2.access.
  const originalFetch = globalThis.fetch
  const stubExchange = (body: Record<string, unknown>) => {
    globalThis.fetch = (async (input: any, init: any) => {
      const params = new URLSearchParams(String(init?.body ?? ''))
      exchanged.push(Object.fromEntries(params.entries()))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
  }

  const cookieFor = (state: Record<string, unknown>) => encryptSecret(JSON.stringify(state))

  const callback = async (opts: { code?: string; state?: string; cookie?: string }) => {
    const url = new URL('https://app.example/api/slack/oauth/callback')
    if (opts.code) url.searchParams.set('code', opts.code)
    if (opts.state) url.searchParams.set('state', opts.state)
    const request = new NextRequest(url)
    if (opts.cookie) request.cookies.set('bslack_oauth', opts.cookie)
    return callbackRoute.GET(request)
  }

  const slackSecretFor = async (organizationId: string) =>
    prisma.integrationSecret.findUnique({
      where: { organizationId_provider: { organizationId, provider: 'slack' } },
    })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ encryptSecret, decryptSecret } = await import('@/lib/crypto/secrets'))
    callbackRoute = await import('../oauth/callback/route')

    const suffix = crypto.randomUUID().slice(0, 8)
    orgA = await prisma.organization.create({
      data: { name: `slack-inst-a-${suffix}`, slug: `slack-inst-a-${suffix}` },
    })
    orgB = await prisma.organization.create({
      data: { name: `slack-inst-b-${suffix}`, slug: `slack-inst-b-${suffix}` },
    })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    for (const org of [orgA, orgB]) {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }
  })

  test('a valid install stores the token, teamId and botUserId', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-a', bot_user_id: 'U0BOT', team: { id: TEAM } })

    const response = await callback({
      code: 'code-1',
      state: 'st-1',
      cookie: cookieFor({ state: 'st-1', organizationId: orgA.id, userId: 'u1', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307, 'the callback redirects the browser back into the app')

    const secret = await slackSecretFor(orgA.id)
    assert.ok(secret, 'expected a slack IntegrationSecret for the installing org')
    const config = secret.authConfig as Record<string, unknown>
    assert.equal(config.teamId, TEAM)
    assert.equal(config.botUserId, 'U0BOT')
    // Stored the same way the paste path stores it: encrypted under apiKey.
    assert.equal(decryptSecret(config.apiKey as string), 'xoxb-a')
    // The platform app verifies against the app-level signing secret, so the
    // install must NOT write one of its own.
    assert.equal(config.signingSecret, undefined)
    // The exchange used the app's embedded identity.
    assert.equal(exchanged[0].client_id, 'client-123')
    assert.equal(exchanged[0].client_secret, 'client-secret-123')
    assert.equal(exchanged[0].code, 'code-1')
  })

  test('a state that does not match the cookie writes nothing', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: `T${crypto.randomUUID().slice(0, 8)}` } })

    const response = await callback({
      code: 'code-2',
      state: 'attacker-state',
      cookie: cookieFor({ state: 'real-state', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0, 'a bad state must be refused BEFORE the code is exchanged')
  })

  test('an expired state writes nothing and never exchanges the code', async () => {
    exchanged = []
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: `T${crypto.randomUUID().slice(0, 8)}` } })
    const response = await callback({
      code: 'code-old',
      state: 'st-old',
      cookie: cookieFor({
        state: 'st-old',
        organizationId: orgB.id,
        userId: 'u2',
        // Eleven minutes old — past SLACK_STATE_MAX_AGE_MS.
        issuedAt: Date.now() - 11 * 60_000,
      }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0)
  })

  test('a missing cookie writes nothing', async () => {
    exchanged = []
    const response = await callback({ code: 'code-3', state: 'st-3' })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
    assert.equal(exchanged.length, 0)
  })

  test('a rejected exchange writes nothing', async () => {
    // Slack answers 200 with ok:false. Trusting the status code here would
    // store an empty token and leave the workspace looking connected.
    stubExchange({ ok: false, error: 'invalid_code' })
    const response = await callback({
      code: 'bad',
      state: 'st-4',
      cookie: cookieFor({ state: 'st-4', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.equal(await slackSecretFor(orgB.id), null)
  })

  test('installing a Slack workspace another org already claims is refused', async () => {
    // orgA claimed TEAM in the first test. With ONE shared app this is a
    // realistic mistake, and the failure mode is every delivery for that
    // workspace silently misrouted.
    stubExchange({ ok: true, access_token: 'xoxb-b', bot_user_id: 'U0BOT', team: { id: TEAM } })
    const response = await callback({
      code: 'code-5',
      state: 'st-5',
      cookie: cookieFor({ state: 'st-5', organizationId: orgB.id, userId: 'u2', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)
    assert.match(response.headers.get('location') ?? '', /slack_team_taken/)
    assert.equal(await slackSecretFor(orgB.id), null)
  })

  test('re-installing the same workspace overwrites the token and stays working', async () => {
    stubExchange({ ok: true, access_token: 'xoxb-a-rotated', bot_user_id: 'U0BOT', team: { id: TEAM } })
    const response = await callback({
      code: 'code-6',
      state: 'st-6',
      cookie: cookieFor({ state: 'st-6', organizationId: orgA.id, userId: 'u1', issuedAt: Date.now() }),
    })
    assert.equal(response.status, 307)

    const secret = await slackSecretFor(orgA.id)
    const config = secret.authConfig as Record<string, unknown>
    assert.equal(decryptSecret(config.apiKey as string), 'xoxb-a-rotated')
    assert.equal(config.teamId, TEAM, 'reinstall must not drop the routing key')
    assert.equal(secret.isActive, true)
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/slack/__tests__/install-callback.db.test.ts`
Expected: FAIL — cannot find `../oauth/callback/route`.

- [ ] **Step 3: Write the install (start) route**

Create `src/app/api/slack/install/route.ts`:

```ts
/**
 * Slack install — STEP 1.
 *
 * GET /api/slack/install?returnTo=/settings
 *
 * Redirects to Slack's consent screen for Backstory's OWN app, carrying a
 * random `state` that is also stored in an encrypted, httpOnly cookie bound to
 * the requesting organization and user. The callback trusts nothing but that
 * cookie — see its file comment.
 *
 * Mirrors src/app/api/mcp-connections/oauth/start/route.ts, which does the same
 * dance for MCP servers.
 */

import { NextResponse } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { encryptSecret } from '@/lib/crypto/secrets'
import { generateState, safeReturnToPath } from '@/lib/mcp/oauth-authcode'
import {
  SLACK_OAUTH_COOKIE,
  SLACK_STATE_MAX_AGE_MS,
  buildSlackAuthorizeUrl,
  type SlackOAuthState,
} from '@/lib/slack/install'

export const runtime = 'nodejs'

/**
 * Ten minutes to finish consenting, matching the MCP flow's window. The cookie
 * maxAge is the browser's copy of this; SLACK_STATE_MAX_AGE_MS in the payload is
 * the authoritative one, checked by the callback.
 */
const COOKIE_MAX_AGE_S = SLACK_STATE_MAX_AGE_MS / 1000

export const GET = withAuthenticatedApi(async (request, auth) => {
  const returnTo = safeReturnToPath(request.nextUrl.searchParams.get('returnTo')?.trim() || undefined)
  const fallback = returnTo ?? '/settings'

  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId || !process.env.SLACK_CLIENT_SECRET) {
    // Misconfiguration, not user error — say so on the page they came from
    // rather than redirecting them into Slack for a guaranteed failure.
    const separator = fallback.includes('?') ? '&' : '?'
    return NextResponse.redirect(new URL(`${fallback}${separator}error=slack_not_configured`, request.nextUrl.origin))
  }

  const state = generateState()
  const payload: SlackOAuthState = {
    state,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    issuedAt: Date.now(),
    ...(returnTo ? { returnTo } : {}),
  }

  const response = NextResponse.redirect(
    buildSlackAuthorizeUrl({
      clientId,
      redirectUri: `${request.nextUrl.origin}/api/slack/oauth/callback`,
      state,
    }),
  )
  response.cookies.set(SLACK_OAUTH_COOKIE, encryptSecret(JSON.stringify(payload)), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  })
  return response
}, { permission: 'integration.manage' })
```

- [ ] **Step 4: Write the callback route**

Create `src/app/api/slack/oauth/callback/route.ts`:

```ts
/**
 * Slack install — STEP 2 (callback).
 *
 * GET /api/slack/oauth/callback?code=...&state=...
 *
 * Slack is the caller, so there is no session. The ONLY authentication is the
 * encrypted `bslack_oauth` cookie minted by the authenticated start route: it
 * carries the organization this install belongs to, and its `state` must match
 * the query parameter. Everything is refused before the code is exchanged —
 * exchanging first would burn a valid code on a request we are about to reject.
 *
 * Writes the SAME IntegrationSecret shape the paste path writes
 * (POST /api/integrations/credentials/slack), so the events receiver,
 * getSlackToken, findSlackWorkspaceByTeamId and the native-plane reads are all
 * untouched — only acquisition changed, not storage.
 *
 * No signingSecret is written: a platform-owned install verifies against the
 * app-level SLACK_SIGNING_SECRET. Only BYO workspaces store their own.
 */

import type { Prisma } from '@prisma/client'
import { NextResponse, type NextRequest } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { decryptSecret, mergeAuthConfig } from '@/lib/crypto/secrets'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { findConflictingSlackOrg } from '@/lib/integrations/slack'
import { SLACK_OAUTH_COOKIE, parseOAuthAccess, stateIsFresh, type SlackOAuthState } from '@/lib/slack/install'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bounce(request: NextRequest, returnTo: string | undefined, query: string) {
  const path = returnTo ?? '/settings'
  const separator = path.includes('?') ? '&' : '?'
  const response = NextResponse.redirect(new URL(`${path}${separator}${query}`, request.nextUrl.origin))
  // One-shot cookie: clear it whichever way this went, so a stale state can
  // never be replayed against a later install.
  response.cookies.delete(SLACK_OAUTH_COOKIE)
  return response
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const state = request.nextUrl.searchParams.get('state')

  let payload: SlackOAuthState | null = null
  const cookie = request.cookies.get(SLACK_OAUTH_COOKIE)?.value
  if (cookie) {
    try {
      payload = JSON.parse(decryptSecret(cookie)) as SlackOAuthState
    } catch {
      payload = null
    }
  }

  // Refused BEFORE the exchange, deliberately. Freshness is checked here rather
  // than left to the cookie's maxAge, which only the browser enforces.
  if (
    !code ||
    !state ||
    !payload ||
    payload.state !== state ||
    !payload.organizationId ||
    !stateIsFresh(payload.issuedAt)
  ) {
    return bounce(request, payload?.returnTo, 'error=slack_oauth_state')
  }

  const clientId = process.env.SLACK_CLIENT_ID
  const clientSecret = process.env.SLACK_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return bounce(request, payload.returnTo, 'error=slack_not_configured')
  }

  try {
    const exchange = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${request.nextUrl.origin}/api/slack/oauth/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    // Slack answers 200 even for a rejected exchange — the body's `ok` is the
    // real result, which is what parseOAuthAccess reads.
    const installed = parseOAuthAccess(await exchange.json().catch(() => null))
    if (!installed) {
      return bounce(request, payload.returnTo, 'error=slack_oauth_exchange')
    }

    // With one shared app, two organizations installing into the SAME Slack
    // workspace is a realistic mistake rather than a theoretical one, and the
    // failure mode is every delivery misrouted with no error and no trail.
    const conflict = await findConflictingSlackOrg(installed.teamId, payload.organizationId)
    if (conflict) {
      await recordAudit({
        organizationId: payload.organizationId,
        action: 'credential.rejected',
        actorUserId: payload.userId,
        resourceType: 'integration_secret',
        resourceId: `slack:${installed.teamId}`,
        detail: { provider: 'slack', reason: 'team_id_already_connected', teamId: installed.teamId, via: 'install' },
      })
      return bounce(request, payload.returnTo, 'error=slack_team_taken')
    }

    // systemPrisma: the caller is Slack, so there is no tenant context to scope
    // by — the organization comes from the verified state cookie above.
    const existing = await systemPrisma.integrationSecret.findUnique({
      where: { organizationId_provider: { organizationId: payload.organizationId, provider: 'slack' } },
      select: { authConfig: true },
    })
    const existingConfig =
      existing?.authConfig && typeof existing.authConfig === 'object' && !Array.isArray(existing.authConfig)
        ? (existing.authConfig as Record<string, unknown>)
        : {}

    // mergeAuthConfig encrypts apiKey itself — do not pre-encrypt. Merging (not
    // replacing) preserves a BYO workspace's own signingSecret if it has one,
    // so switching to the platform app never strips its ability to verify.
    const authConfig = {
      ...(mergeAuthConfig(existingConfig, { authType: 'api_key', apiKey: installed.botToken }) as Record<string, unknown>),
      teamId: installed.teamId,
      botUserId: installed.botUserId,
    } as Prisma.InputJsonObject

    await systemPrisma.integrationSecret.upsert({
      where: { organizationId_provider: { organizationId: payload.organizationId, provider: 'slack' } },
      update: { authType: 'api_key', authConfig, isActive: true, lastRotatedAt: new Date() },
      create: { organizationId: payload.organizationId, provider: 'slack', authType: 'api_key', authConfig, isActive: true },
    })

    await recordAudit({
      organizationId: payload.organizationId,
      action: 'credential.granted',
      actorUserId: payload.userId,
      resourceType: 'integration_secret',
      resourceId: `slack:${installed.teamId}`,
      detail: { provider: 'slack', teamId: installed.teamId, via: 'install' },
    })

    return bounce(request, payload.returnTo, 'slack=installed')
  } catch (error) {
    apiLogger.error('slack install callback failed', {
      organizationId: payload.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return bounce(request, payload.returnTo, 'error=slack_oauth_failed')
  }
}
```

- [ ] **Step 5: Register both routes in the inventories**

In `src/lib/authz/ungated-routes.ts`, after the `'mcp-connections/oauth/callback'` line:

```ts
  'slack/oauth/callback',                 // OAuth redirect, validated by the encrypted state cookie
```

In `src/app/api/__tests__/route-smoke.test.ts`, add to `readExempt` after `'mcp-connections/oauth/callback',`:

```ts
  'slack/oauth/callback',           // OAuth redirect, validated by the encrypted state cookie
```

and add to `skipped`, after the `admin/adoption` entry:

```ts
    // Returns a 307 to Slack's consent screen, not JSON, and only when
    // SLACK_CLIENT_ID/SECRET are set. Covered against a real database in
    // src/app/api/slack/__tests__/install-callback.db.test.ts.
    { route: 'slack/install', reason: 'redirects to Slack OAuth; not a JSON smoke target' },
```

- [ ] **Step 6: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/slack/__tests__/install-callback.db.test.ts src/app/api/__tests__/permission-coverage.test.ts src/app/api/__tests__/route-smoke.test.ts src/app/api/__tests__/edition-gates.test.ts`
Expected: PASS. A `permission-coverage` failure naming `slack/oauth/callback` means Step 5's first edit was missed; a `route-smoke` failure naming either route means the second or third was.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/app/api/slack/install src/app/api/slack/oauth src/lib/authz/ungated-routes.ts src/app/api/__tests__/route-smoke.test.ts src/app/api/slack/__tests__/install-callback.db.test.ts
git commit -m "feat(slack): Add to Slack install flow for the platform-owned app

Two routes: an authenticated start that mints a state cookie bound to
the org, and a callback authenticated ONLY by that cookie since Slack is
the caller.

Everything is refused before the code is exchanged — a bad state that
exchanged first would burn a valid code on a request we then reject.
Slack answers 200 even for a rejected exchange, so ok in the body is the
real result.

Writes the same IntegrationSecret shape the paste path writes, so the
events receiver, getSlackToken and findSlackWorkspaceByTeamId are
untouched. No signingSecret is written: platform installs verify against
the app-level one, and merging rather than replacing preserves a BYO
workspace's own if it has one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: "Add to Slack" in the UI, and the docs

**Files:**
- Modify: `src/components/integrations/workspace-credentials-panel.tsx`
- Modify: `.env.example`
- Modify: `docs/runbooks/activity-plane.md` §5

**Interfaces:**
- Consumes: `GET /api/slack/install` from Task 3
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Read the panel and find the Slack section**

Run: `grep -n "slack" src/components/integrations/workspace-credentials-panel.tsx`
Expected: the Slack credential row, with its bot-token and signing-secret fields.

- [ ] **Step 2: Add the install button above the manual fields**

Put "Add to Slack" first and demote the paste fields to a disclosure, so the install is the obvious path and BYO is visibly the exception. The button is a plain link — the route returns a redirect, so it must be a navigation, not a `fetch`:

```tsx
<a
  href="/api/slack/install?returnTo=/settings"
  className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
>
  Add to Slack
</a>
<p className="mt-2 text-sm text-muted-foreground">
  Installs Backstory&apos;s Slack app in your workspace. Nobody needs to create a
  Slack app, and no token is handled by hand — so nothing breaks when the person
  who set it up leaves.
</p>
```

Under a collapsed "Use your own Slack app instead" disclosure, keep the existing bot-token and signing-secret fields exactly as they are.

- [ ] **Step 3: Surface the redirect outcomes**

The callback returns to `/settings` with one of `slack=installed`, `error=slack_oauth_state`, `error=slack_oauth_exchange`, `error=slack_team_taken`, `error=slack_not_configured`, or `error=slack_oauth_failed`. Read them with `useSearchParams()` and render one line each:

```tsx
const SLACK_INSTALL_MESSAGES: Record<string, string> = {
  slack_oauth_state: 'That install link expired or did not match. Start again from Add to Slack.',
  slack_oauth_exchange: 'Slack rejected the install. Start again from Add to Slack.',
  slack_team_taken: 'That Slack workspace is already connected to a different Backstory workspace.',
  slack_not_configured: 'Slack install is not configured on this deployment yet.',
  slack_oauth_failed: 'Could not reach Slack to finish the install. Please try again.',
}
```

On `slack=installed`, say what is true and what is still needed — this is the design's most likely support question, because with a platform-owned app it is natural to assume the install covered everyone:

```tsx
<p className="text-sm">
  Slack is connected. Each person still links their own Slack account before they
  can use agents there — installing the app connects the workspace, not individuals.
</p>
```

- [ ] **Step 4: Document the three env vars**

In `.env.example`, add:

```bash
# Backstory's own Slack app (Basic Information -> App Credentials).
# Platform-embedded and shared across every install: workspaces click
# "Add to Slack" and their per-workspace bot token is minted by Slack and
# stored automatically, so no one handles a token by hand.
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
# Verifies inbound Events API deliveries. Shared across installs by design —
# it is a signature verifier, not an identity. A BYO workspace's own secret
# takes precedence over this one.
SLACK_SIGNING_SECRET=
# Deliberately UNSET. A shared bot token is a shared identity; per-install
# tokens make it unnecessary. Only internal/partner orgs could use it anyway.
# SLACK_BOT_TOKEN=
```

- [ ] **Step 5: Rewrite runbook §5 to lead with install**

In `docs/runbooks/activity-plane.md`, replace the opening of §5 (currently "Everything below is one workspace's own Slack app (BYO-app; there is no Backstory-owned Slack app every customer installs into…)") with:

```markdown
## 5. Connecting Slack

There are two paths, and the first is the default.

**Install Backstory's app (default).** The workspace admin clicks "Add to Slack"
on /settings. Slack mints a bot token for that workspace and the callback stores
it; nobody creates an app and nobody handles a token. This exists because BYO
failed operationally — the person who created a workspace's app leaves, nobody
can reach its settings, and the workspace has a bot it can neither administer nor
replace.

The platform side needs `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and
`SLACK_SIGNING_SECRET` set once (see .env.example). Per-workspace bot tokens are
minted by Slack at install; there is no single embeddable bot token, because
`oauth.v2.access` issues a distinct one per install.

**Bring your own app (exception).** Everything below still works for a workspace
that wants its own Slack app, and its own signing secret takes precedence over
the app-level one.
```

Keep the rest of §5 as the BYO instructions, and add `app_mentions:read` and `chat:write.customize` to its bot-scope list with a note that Plan B's mention handling needs them.

- [ ] **Step 6: Typecheck, lint and commit**

Run: `npm run typecheck && npx eslint src/components/integrations --max-warnings=0`
Expected: clean.

```bash
git add src/components/integrations/workspace-credentials-panel.tsx .env.example docs/runbooks/activity-plane.md
git commit -m "feat(slack): Add to Slack in settings, and document the app identity

Install leads; the bot-token and signing-secret fields become a
disclosure, so BYO is visibly the exception rather than the default.

The success message says what the install did NOT do: it connects the
workspace, not individuals, and each person still links their own Slack
account. With a platform-owned app that is the assumption people will
otherwise make.

Documents SLACK_CLIENT_ID/SECRET/SIGNING_SECRET in .env.example, none of
which were recorded anywhere, and notes why SLACK_BOT_TOKEN stays unset.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full gate

**Files:** none created; verification only.

- [ ] **Step 1: Run the full gate in CI mode**

Run: `npm run typecheck && npm run lint && npm test` with `TEST_DATABASE_URL`, `DATABASE_URL` and `DIRECT_URL` all pointed at the local `ci_repro` Postgres.
Expected: tsc clean, 0 lint errors (pre-existing warnings only), 0 test failures.

- [ ] **Step 2: Confirm no route inventory drifted**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/app/api/__tests__/permission-coverage.test.ts src/app/api/__tests__/route-smoke.test.ts src/app/api/__tests__/edition-gates.test.ts`
Expected: PASS.

- [ ] **Step 3: Record in the ledger**

Append the outcome to `.superpowers/sdd/progress.md`: what shipped, the guard narrowing and why it is not a weakening, the final gate line, and the deploy-time steps below.

- [ ] **Step 4: Commit the ledger**

```bash
git add .superpowers/sdd/progress.md
git commit -m "docs(slack): ledger entry for the platform-owned install flow

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **No Fly worker redeploy for this plan.** Nothing here touches the agent runtime. Plan B does.
- **Deploy-time steps the user must do**, in this order: set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` in Vercel (Production + Preview); add `https://<host>/api/slack/oauth/callback` to the Slack app's **Redirect URLs**; confirm the bot scopes match `SLACK_BOT_SCOPES`. The install will fail with `error=slack_not_configured` until the first is done and with a Slack-side error until the second is.
- **The install cannot be verified end to end locally.** It needs a real Slack consent round trip against a public callback URL. The DB suite stubs the exchange and covers every branch of the callback, which is where the security lives; the round trip itself is a post-deploy check.
- **Do not add `SLACK_BOT_TOKEN` to Vercel.** It exists only as an internal/partner escape hatch and is unnecessary once installs mint per-workspace tokens.
