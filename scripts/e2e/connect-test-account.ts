/**
 * The second (and last) one-time step after provision-test-account.ts: sign in
 * AS the end-to-end test account and authorize its setup gates — the Backstory
 * MCP connection (with the Keyslogic demo tenant's login, so every journey
 * reads demo data only) and, where the deployment enforces it, the People.ai
 * entitlement.
 *
 *   E2E_BASE_URL=https://… E2E_SUPABASE_URL=https://<ref>.supabase.co \
 *   E2E_SUPABASE_ANON_KEY=… E2E_USER_EMAIL=… E2E_USER_PASSWORD=… \
 *   npx tsx scripts/e2e/connect-test-account.ts           # opens a browser on /connect
 *   npx tsx scripts/e2e/connect-test-account.ts --check   # headless: exit 0 iff ready
 *
 * Why a browser and not a database write: the gate is satisfied by a REAL
 * OAuth grant, which refreshes itself from then on. Writing a placeholder token
 * would pass the gate and then fail every tool call — a test account that lies
 * about being connected is worse than one that says it is not.
 *
 * The session is minted exactly the way the suite mints it
 * (e2e/support/session.ts), so if this script gets in, so will CI.
 */
import { chromium } from '@playwright/test'
import { mintSession, sessionCookies } from '../../e2e/support/session'

type SetupStatus = { success?: boolean; entitled?: boolean; backstoryConnected?: boolean; code?: string; error?: string }

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`✗ ${name} is required. See docs/e2e-authenticated-setup.md.`)
    process.exit(1)
  }
  return value
}

function describe(status: SetupStatus): string {
  if (!status.success) return `refused: ${status.code ?? 'error'} ${status.error ?? ''}`.trim()
  return `Backstory MCP ${status.backstoryConnected ? 'connected' : 'NOT connected'}, entitlement ${status.entitled ? 'ok' : 'MISSING'}`
}

async function main(): Promise<void> {
  const baseUrl = required('E2E_BASE_URL').replace(/\/$/, '')
  const supabaseUrl = required('E2E_SUPABASE_URL')
  const anonKey = required('E2E_SUPABASE_ANON_KEY')
  const email = required('E2E_USER_EMAIL')
  const password = required('E2E_USER_PASSWORD')
  const checkOnly = process.argv.includes('--check')

  const session = await mintSession({ supabaseUrl, anonKey, email, password, captchaToken: process.env.E2E_CAPTCHA_TOKEN?.trim() || undefined })
  console.log('✓ Signed in at the Supabase token endpoint')

  const browser = await chromium.launch({ headless: checkOnly })
  try {
    const context = await browser.newContext()
    await context.addCookies(sessionCookies({ session, supabaseUrl, baseUrl }))
    const status = async (): Promise<SetupStatus> => {
      const response = await context.request.get(`${baseUrl}/api/setup/status`)
      return (await response.json().catch(() => ({ success: false, error: `HTTP ${response.status()}` }))) as SetupStatus
    }
    const ready = (value: SetupStatus) => Boolean(value.success && value.backstoryConnected && value.entitled)

    let current = await status()
    console.log(`  ${describe(current)}`)
    if (ready(current)) {
      console.log('✓ The test account passes every setup gate. Nothing to do.')
      return
    }
    if (current.code === 'MFA_REQUIRED') throw new Error('This account is MFA-gated — it is privileged. Provision an ordinary workspace admin instead.')
    if (checkOnly) process.exit(1)

    const page = await context.newPage()
    await page.goto(`${baseUrl}/connect`)
    console.log('\nA browser is open on /connect, signed in as the test account.')
    console.log('Connect the Backstory MCP with the KEYSLOGIC DEMO login (and People.ai, if the page asks).')
    console.log('This script finishes by itself once the gates report ready (15 minute limit).\n')

    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      current = await status()
      if (ready(current)) {
        console.log(`✓ ${describe(current)} — the test account is ready for the authenticated journeys.`)
        return
      }
    }
    throw new Error(`Timed out. Last status: ${describe(current)}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
