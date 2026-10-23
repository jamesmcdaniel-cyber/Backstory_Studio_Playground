/**
 * One-time (and safely re-runnable) provisioning of the identity the signed-in
 * browser journeys sign in as. An OPERATOR runs this against the environment
 * the suite will target — never CI, never the app.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
 *   DATABASE_URL=<direct postgres url for the same environment> \
 *   E2E_USER_EMAIL=e2e-journeys@backstory.ai \
 *   [E2E_USER_PASSWORD=<choose one, or omit to have one generated>] \
 *   [E2E_SUPABASE_ANON_KEY=<anon key — proves the password grant works>] \
 *   npx tsx scripts/e2e/provision-test-account.ts [--rotate-password] [--extra-mcp-url https://…]
 *
 * See docs/e2e-authenticated-setup.md for the whole procedure.
 *
 * ── What it creates ──────────────────────────────────────────────────────
 *  1. A Supabase Auth user for E2E_USER_EMAIL, email pre-confirmed, with a
 *     password, stamped `app_metadata.e2e_test_account = true`.
 *  2. A dedicated workspace, slug `e2e-journeys`, kind `customer`, MFA policy
 *     `optional`, holding exactly that one person as a workspace ADMIN.
 *  3. Optionally (--extra-mcp-url) an org-shared, no-auth MCP server in that
 *     workspace, for stacks where the Backstory MCP cannot be authorized (a
 *     laptop). Production uses the Keyslogic demo Backstory MCP instead — see
 *     scripts/e2e/connect-test-account.ts.
 *
 * ── Why nothing is weakened for anyone else ──────────────────────────────
 * The app has no switch for "password sign-in": a password is a Supabase Auth
 * credential, already settable from Settings and resettable by an admin, and
 * Supabase's token endpoint accepts it for any user that HAS one. Real users
 * sign in with Google/SAML and have none. So "a password grant for this user
 * only" is exactly what setting one password on one user is — no environment
 * variable, allowlist, or app code path is opened by this script.
 * (AUTH_ALLOW_PASSWORD only re-opens the /auth/signup PAGE; it is not needed.)
 *
 * Admission: the user row is created here, so resolveAuthUser takes its
 * existing-account branch and asks only the revocation question. Nothing is
 * added to PlatformAllowedDomain or ALLOWED_EMAIL_DOMAINS, so no other address
 * at the test domain gains access.
 *
 * ── What it refuses ──────────────────────────────────────────────────────
 *  - a platform-owner or platform-staff address (privileged accounts are held
 *    to MFA, which a password session can never satisfy, and must never be a
 *    shared CI credential anyway);
 *  - an address that already belongs to someone: an existing Supabase user
 *    WITHOUT the e2e stamp, or an app user row outside the test workspace;
 *  - a test workspace that contains anyone but the test user;
 *  - a domain whose workspace enforces SSO (the password session would be
 *    refused SSO_REQUIRED on every request).
 *
 * Re-running is a no-op apart from what you ask for: the password changes only
 * when E2E_USER_PASSWORD is given or --rotate-password is passed.
 */
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { createClient, type User } from '@supabase/supabase-js'
import { isPlatformOwnerEmail } from '../../src/lib/authz/platform-owner'
import { normalizeStaffEmail, staffBootstrapAllowlist } from '../../src/lib/catalogue/staff-emails'

export const E2E_WORKSPACE_SLUG = 'e2e-journeys'
const E2E_WORKSPACE_NAME = 'E2E Journeys (automated test workspace)'
const E2E_USER_NAME = 'E2E Journeys Bot'
const EXTRA_MCP_NAME = 'E2E public MCP (test only)'
const DEFAULT_EMAIL = 'e2e-journeys@backstory.ai'

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function required(name: string, ...fallbacks: string[]): string {
  for (const key of [name, ...fallbacks]) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  fail(`${[name, ...fallbacks].join(' or ')} is required. See docs/e2e-authenticated-setup.md.`)
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function generatePassword(): string {
  // 36 url-safe characters ≈ 216 bits. Printed once; store it as the secret.
  return randomBytes(27).toString('base64url')
}

async function findAuthUser(admin: ReturnType<typeof createClient>['auth']['admin'], email: string): Promise<User | null> {
  // The admin API has no lookup-by-email; page through. Fine for an operator
  // script run once, even on a project with tens of thousands of users.
  for (let page = 1; page < 1_000; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 1000 })
    if (error) fail(`Supabase admin listUsers failed: ${error.message}`)
    const match = data.users.find((user) => user.email?.toLowerCase() === email)
    if (match) return match
    if (data.users.length < 1000) return null
  }
  return null
}

async function main(): Promise<void> {
  const supabaseUrl = required('SUPABASE_URL', 'E2E_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')
  const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY')
  const databaseUrl = required('DATABASE_URL')
  const anonKey = process.env.E2E_SUPABASE_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  const email = (process.env.E2E_USER_EMAIL?.trim() || DEFAULT_EMAIL).toLowerCase()
  const givenPassword = process.env.E2E_USER_PASSWORD?.trim() || undefined
  const extraMcpUrl = option('--extra-mcp-url')

  // ── Refusals that need no network ────────────────────────────────────────
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`E2E_USER_EMAIL "${email}" is not an email address.`)
  if (isPlatformOwnerEmail(email)) fail(`${email} is a platform owner address. The test account must be an ordinary workspace admin.`)
  if (staffBootstrapAllowlist().has(normalizeStaffEmail(email)!)) {
    fail(`${email} is on the platform-staff allowlist (PLATFORM_STAFF_EMAILS). Staff are super admins: MFA-gated and exempt from the free-tier ceiling the suite asserts.`)
  }
  if (givenPassword && givenPassword.length < 16) fail('E2E_USER_PASSWORD must be at least 16 characters — it is a shared CI credential.')
  if (extraMcpUrl && !/^https:\/\//.test(extraMcpUrl)) fail('--extra-mcp-url must be an https URL (the app refuses anything else).')

  // A raw client on purpose: this is an operator script holding the direct
  // database URL, not a request with a tenant. Every org-scoped query below
  // still names organizationId.
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl })
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin

  try {
    const staffGrant = await prisma.platformStaffEmail.findUnique({ where: { email }, select: { id: true } })
    if (staffGrant) fail(`${email} has a platform-staff grant (platform_staff_emails). Pick an address that is not staff.`)

    const domain = email.split('@')[1]
    const ssoDomain = await prisma.organizationDomain.findFirst({
      where: { domain, status: 'verified', identityProviderId: { not: null } },
      select: { organization: { select: { ssoEnforcement: true, ssoEnforced: true } } },
    })
    if (ssoDomain && (ssoDomain.organization?.ssoEnforcement === 'required' || ssoDomain.organization?.ssoEnforced)) {
      fail(`${domain} is claimed by a workspace that REQUIRES single sign-on, so a password session would be refused SSO_REQUIRED. Use an address at another domain.`)
    }

    // ── 1. The Supabase identity ───────────────────────────────────────────
    let password: string | undefined = givenPassword
    let authUser = await findAuthUser(admin, email)
    if (authUser) {
      if (authUser.app_metadata?.e2e_test_account !== true) {
        fail(
          `A Supabase user for ${email} already exists and was NOT created by this script ` +
            '(no app_metadata.e2e_test_account stamp). Refusing to set a password on what may be a real person. ' +
            'Choose a different E2E_USER_EMAIL.',
        )
      }
      if (!password && flag('--rotate-password')) password = generatePassword()
      const { data, error } = await admin.updateUserById(authUser.id, {
        email_confirm: true,
        ...(password ? { password } : {}),
        app_metadata: { e2e_test_account: true },
        user_metadata: { name: E2E_USER_NAME },
      })
      if (error) fail(`Updating the Supabase user failed: ${error.message}`)
      authUser = data.user
      console.log(`✓ Supabase user exists (${authUser.id})${password ? ' — password set' : ' — password unchanged'}`)
    } else {
      password = password ?? generatePassword()
      const { data, error } = await admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { e2e_test_account: true },
        user_metadata: { name: E2E_USER_NAME },
      })
      if (error || !data.user) fail(`Creating the Supabase user failed: ${error?.message ?? 'no user returned'}`)
      authUser = data.user
      console.log(`✓ Supabase user created (${authUser.id})`)
    }

    // ── 2. The workspace and the app user ──────────────────────────────────
    const byEmail = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, NOT: { supabaseId: authUser.id } },
      select: { id: true, organizationId: true },
    })
    if (byEmail) fail(`An app user with ${email} already exists under a different identity (${byEmail.id}). Refusing to touch it.`)

    const organization = await prisma.organization.upsert({
      where: { slug: E2E_WORKSPACE_SLUG },
      update: {},
      create: { name: E2E_WORKSPACE_NAME, slug: E2E_WORKSPACE_SLUG, kind: 'customer', mfaPolicy: 'optional' },
    })
    if (organization.kind !== 'customer') fail(`Workspace ${E2E_WORKSPACE_SLUG} exists with kind "${organization.kind}"; the suite needs a plain customer workspace.`)
    if (organization.mfaPolicy !== 'optional' || organization.ssoEnforced || organization.ssoEnforcement === 'required') {
      fail(`Workspace ${E2E_WORKSPACE_SLUG} requires MFA or SSO; a password session cannot satisfy either. Reset it to optional.`)
    }

    const strangers = await prisma.user.count({
      where: { organizationId: organization.id, NOT: { supabaseId: authUser.id } },
    })
    if (strangers > 0) {
      fail(`Workspace ${E2E_WORKSPACE_SLUG} holds ${strangers} other user(s). It is not a test workspace this script owns; refusing to continue.`)
    }

    const existingRow = await prisma.user.findUnique({ where: { supabaseId: authUser.id }, select: { organizationId: true } })
    if (existingRow?.organizationId && existingRow.organizationId !== organization.id) {
      fail(`The test identity's app user lives in another workspace (${existingRow.organizationId}). Refusing to move it.`)
    }
    const user = await prisma.user.upsert({
      where: { supabaseId: authUser.id },
      update: { email, name: E2E_USER_NAME, role: 'ADMIN', platformRole: null, isActive: true, organizationId: organization.id },
      create: {
        supabaseId: authUser.id,
        email,
        name: E2E_USER_NAME,
        role: 'ADMIN',
        organizationId: organization.id,
        metadata: { e2eTestAccount: true },
      },
    })
    console.log(`✓ Workspace "${organization.name}" (${organization.id}) with ${email} as its only member, role ADMIN`)

    // ── 3. Optional no-auth MCP server (laptop stacks) ─────────────────────
    if (extraMcpUrl) {
      const existing = await prisma.mcpConnection.findFirst({
        where: { organizationId: organization.id, userId: null, name: EXTRA_MCP_NAME },
        select: { id: true },
      })
      const data = {
        serverUrl: extraMcpUrl,
        authType: 'none',
        authConfig: {},
        isActive: true,
        description: 'Public, no-auth MCP server used by the end-to-end journeys. Safe to delete.',
        lastVerifiedAt: new Date(),
        healthStatus: 'unknown',
      }
      if (existing) {
        await prisma.mcpConnection.updateMany({ where: { id: existing.id, organizationId: organization.id }, data })
      } else {
        await prisma.mcpConnection.create({ data: { ...data, organizationId: organization.id, name: EXTRA_MCP_NAME } })
      }
      console.log(`✓ Shared MCP server "${EXTRA_MCP_NAME}" → ${extraMcpUrl}`)
    }

    // ── 4. Report what still stands between this account and the app ──────
    const backstory = await prisma.mcpConnection.findFirst({
      where: { organizationId: organization.id, userId: user.id, provider: 'backstory' },
      select: { isActive: true, authConfig: true },
    })
    // Mirrors evaluateBackstoryReady (src/lib/mcp/backstory-connection.ts),
    // restated so this script does not import the app's Prisma singleton.
    const config = backstory?.authConfig as Record<string, unknown> | null | undefined
    const backstoryReady = Boolean(backstory?.isActive && config?.flow === 'authcode' && typeof config.accessToken === 'string' && config.accessToken)
    const peopleAi = await prisma.peopleAiConnection.findFirst({
      where: { organizationId: organization.id, status: 'active', membershipId: { not: null } },
      select: { id: true },
    })

    if (anonKey && password) {
      const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (response.ok) console.log('✓ Password grant verified at the Supabase token endpoint')
      else console.log(`! Password grant refused (${response.status}): ${await response.text()} — see "Troubleshooting" in docs/e2e-authenticated-setup.md`)
    }

    console.log('\nGitHub secrets (Settings → Secrets and variables → Actions):')
    console.log(`  E2E_USER_EMAIL        = ${email}`)
    console.log(password ? `  E2E_USER_PASSWORD     = ${password}   ← shown once; store it now` : '  E2E_USER_PASSWORD     = (unchanged — pass --rotate-password to mint a new one)')
    console.log(`  E2E_SUPABASE_URL      = ${supabaseUrl}`)
    console.log('  E2E_SUPABASE_ANON_KEY = the project\'s anon (publishable) key')
    console.log('  E2E_BASE_URL          = the deployment that authenticates against that project')
    console.log('\nSetup gates for this workspace:')
    console.log(`  Backstory MCP connected: ${backstoryReady ? 'yes' : 'NO'}`)
    console.log(`  People.ai entitlement:   ${peopleAi ? 'yes' : 'no (only matters when the deployment runs ENTITLEMENT_GATE=on without native Sales AI mode)'}`)
    if (!backstoryReady) {
      console.log('\nNext: authorize the Keyslogic demo Backstory MCP for this account, once:')
      console.log('  E2E_BASE_URL=… E2E_SUPABASE_URL=… E2E_SUPABASE_ANON_KEY=… E2E_USER_EMAIL=… E2E_USER_PASSWORD=… \\')
      console.log('  npx tsx scripts/e2e/connect-test-account.ts')
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)))
