/**
 * The authenticated project's dependency: mints one session, proves it is
 * genuinely authenticated, and saves it as storage state for every journey.
 *
 * Runs as a TEST rather than as a `globalSetup` function so that it appears in
 * the report with a name and a status. A globalSetup that skipped would be
 * invisible; this one shows up as a skipped test with the reason attached,
 * which is the whole point — a suite that stops testing must SAY so.
 *
 * When it cannot sign in it still writes an EMPTY storage state, so the
 * dependent projects load cleanly and each of their specs reports its own loud
 * skip. Failing to write the file would instead error the whole project out
 * with a file-not-found, which reads like infrastructure breakage rather than
 * like missing configuration.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, test as setup, type Page } from '@playwright/test'
import { addJavaScriptStep } from './support/builder'
import { AUTH_MARKER, STORAGE_STATE, authSkipReason, baseUrl, isLocalTarget, supabaseTarget, testUserCredentials } from './support/env'
import { applySession, mintSession } from './support/session'

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/** An empty state is a valid state — it just carries no session. */
function writeEmptyState(reason: string): void {
  if (!existsSync(STORAGE_STATE)) write(STORAGE_STATE, JSON.stringify({ cookies: [], origins: [] }))
  write(AUTH_MARKER, JSON.stringify({ authenticated: false, reason }, null, 2))
}

/** Every surface a journey visits; the builder path compiles the builder bundle on a missing flow. */
const WARM_PATHS = [
  '/dashboard', '/flows', '/flows/e2e-warm-up', '/agents', '/artifacts', '/settings',
  '/settings?tab=members', '/integrations', '/integrations?tab=servers', '/credentials', '/invite/e2e-warm-up',
]

/**
 * API routes the journeys reach only by ACTING (running, chatting, toggling),
 * which page visits never compile. Hit with a placeholder id: the answer is a
 * 404 or 400, but the route module is compiled — so the first compile does not
 * land mid-journey, where `next dev` may answer it with a full page reload.
 */
const WARM_ROUTES: Array<['GET' | 'POST' | 'PATCH', string]> = [
  ['POST', '/api/flows/e2e-warm-up/execute'], ['GET', '/api/flows/e2e-warm-up/runs'], ['GET', '/api/flows/e2e-warm-up/review'],
  ['GET', '/api/flows/tool-catalog'], ['GET', '/api/flows/statuses'], ['GET', '/api/flow-templates'],
  ['POST', '/api/flow-templates/e2e-warm-up/use'], ['GET', '/api/agents/e2e-warm-up/chat'], ['POST', '/api/agents/e2e-warm-up/chat'],
  ['GET', '/api/agents/e2e-warm-up/chat/sessions'], ['POST', '/api/agents/e2e-warm-up/execute'],
  ['GET', '/api/mcp-connections/e2e-warm-up/tools?all=1'], ['PATCH', '/api/mcp-connections/e2e-warm-up/tools'],
  ['GET', '/api/organizations/invitations'], ['GET', '/api/artifacts'], ['GET', '/api/workflows/executions'],
  ['POST', '/api/flows/e2e-warm-up/publish'],
]

/** Build, run and delete a one-step JavaScript flow — warm-up only, never asserted. */
async function warmFlowRun(page: Page): Promise<void> {
  page.setDefaultTimeout(300_000)
  await page.goto('/flows')
  await page.getByRole('button', { name: 'New flow' }).click()
  await page.getByRole('button', { name: /blank flow/i }).click()
  await page.waitForURL(/\/flows\/[^/?]+/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  try {
    await addJavaScriptStep(page)
    await page.getByRole('button', { name: 'Save now' }).click()
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.getByTestId('runs-panel').getByText(/^succeeded|^failed/i).first().waitFor({ timeout: 180_000 })
  } finally {
    await page.request.delete('/api/flows', { data: { id } }).catch(() => undefined)
  }
}

setup('authenticate the end-to-end test user', async ({ context, request }) => {
  const reason = authSkipReason()
  if (reason) writeEmptyState(reason)
  setup.skip(Boolean(reason), reason ?? '')

  const target = supabaseTarget()!
  const credentials = testUserCredentials()!

  const session = await mintSession({
    supabaseUrl: target.url,
    anonKey: target.anonKey,
    email: credentials.email,
    password: credentials.password,
    captchaToken: process.env.E2E_CAPTCHA_TOKEN?.trim() || undefined,
  })

  await applySession(context, { session, supabaseUrl: target.url, baseUrl: baseUrl() })

  // The session is not proven by the cookie existing — it is proven by the
  // server accepting it. /api/auth/context runs the full resolution chain
  // (Supabase getUser → Prisma user → organization → permissions) with only
  // the MFA and SSO gates skipped, so a 200 here means every other authenticated
  // route will resolve an org for this identity too.
  const probe = await context.request.get(`${baseUrl()}/api/auth/context`)
  const body = await probe.text()
  expect(
    probe.status(),
    `The minted session was refused by /api/auth/context (${probe.status()}): ${body}\n` +
      'Common causes: the user\'s email is not admitted by isAllowedEmail (company domain, ' +
      'ALLOWED_EMAIL_DOMAINS, a PlatformAllowedDomain row, or a live PENDING invitation); ' +
      'the account is deactivated; or ENTITLEMENT_GATE / BACKSTORY_MCP_GATE are on for this deploy.',
  ).toBe(200)

  const context_ = JSON.parse(body).context as { organizationId: string; userId: string; permissions: string[] }
  expect(context_.organizationId, 'the test user resolved no workspace').toBeTruthy()

  // Recorded for the specs: whether this identity is exempt from the free-tier
  // ceilings. The daily-run-cap journey asserts a REFUSAL, which an exempt
  // account can never produce — better to say so than to fail mysteriously.
  const canReview = context_.permissions.includes('catalogue.review')

  // A laptop `next dev` compiles each page and API route on first request —
  // the flow builder alone takes longer than a journey's whole budget on a cold
  // server. Visiting every surface once here, serially, means the journeys
  // measure the product rather than the compiler. Deployed targets skip this.
  if (isLocalTarget() && process.env.E2E_WARM_UP !== '0') {
    setup.setTimeout(900_000)
    const warm = await context.newPage()
    for (const path of WARM_PATHS) {
      await warm.goto(path, { timeout: 300_000 }).catch(() => undefined)
      await warm.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined)
    }
    for (const [method, path] of WARM_ROUTES) {
      await context.request.fetch(`${baseUrl()}${path}`, { method, data: method === 'GET' ? undefined : {}, timeout: 300_000 }).catch(() => undefined)
    }
    // And one real run: executing a flow loads the executor and the code
    // sandbox lazily, and on a cold server that compile reloads the open page —
    // wiping the very Runs-panel state the run journeys assert on.
    await warmFlowRun(warm).catch(() => undefined)
    await warm.close()
  }

  await context.storageState({ path: STORAGE_STATE })
  write(
    AUTH_MARKER,
    JSON.stringify(
      { authenticated: true, userId: context_.userId, organizationId: context_.organizationId, canReview },
      null,
      2,
    ),
  )

  // `request` is unused for assertions but keeps the fixture list honest about
  // what this setup touches.
  void request
})
