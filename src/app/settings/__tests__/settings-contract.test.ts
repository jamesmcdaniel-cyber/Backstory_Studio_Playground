import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Settings shipped with several options that RENDERED but could not complete.
 * Each one was invisible to typecheck (the button existed, the fetch was
 * well-typed, the route existed) and only failed at the moment a user clicked
 * it. These pin the wiring the same way the credential-surface guards do.
 */

/**
 * Comments explain why an API is NOT used, so scanning them alongside the code
 * makes every "we no longer call window.prompt" note read as a violation of
 * itself. Same stripping the layout contract does.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'))

const page = read('src/app/settings/page.tsx')
const members = read('src/components/settings/members-section.tsx')
const security = read('src/components/settings/enterprise-security-section.tsx')
const developer = read('src/components/settings/developer-api-section.tsx')
const mfaSection = read('src/components/settings/mfa-section.tsx')
const permissions = read('src/lib/authz/permissions.ts')

test('the settings page renders WorkspaceCredentialsPanel', () => {
  assert.match(page, /WorkspaceCredentialsPanel/, 'the workspace keys panel must be reachable from /settings')
})

test('every settings section is reachable as its own tab', () => {
  for (const tab of ['account', 'workspace', 'members', 'keys', 'security', 'developer', 'notifications', 'billing', 'data', 'platform']) {
    assert.match(page, new RegExp(`id: '${tab}'`), `the ${tab} section must have a tab`)
    assert.match(page, new RegExp(`active === '${tab}'`), `the ${tab} tab must render a panel`)
  }
  // Deep-linkable: a tab is a URL, so other surfaces can point straight at it.
  assert.match(page, /\/settings\?tab=\$\{id\}/, 'the active tab must live in the query string')
  assert.match(page, /searchParams\.get\('tab'\)/, 'the active tab must be read back from the URL')
})

test('destructive and secret-bearing actions do not use native dialogs', () => {
  // window.prompt cannot show a one-time secret reliably (unselectable on iOS,
  // suppressible by the browser) and window.confirm cannot show what is being
  // deleted. Both carried real secrets here.
  for (const [name, source] of [['page', page], ['security', security], ['developer', developer]] as const) {
    assert.doesNotMatch(source, /window\.prompt/, `${name} must not carry a secret or confirmation in window.prompt`)
    assert.doesNotMatch(source, /window\.confirm/, `${name} must not confirm a destructive action with window.confirm`)
  }
  assert.match(page, /SecretDialog|ConfirmDialog/, 'settings must use the in-app dialogs')
})

test('workspace deletion is gated on the permission the route actually checks', () => {
  // /api/privacy/workspace requires workspace.delete, which the registry grants
  // to OWNER only. Gating the button on isAdmin showed it to every admin and
  // answered 403 after they had typed the workspace name to confirm.
  assert.match(permissions, /workspace\.delete/, 'the permission must exist')
  assert.doesNotMatch(
    permissions.slice(permissions.indexOf('const ADMIN_PERMISSIONS'), permissions.indexOf('const BY_ROLE')),
    /workspace\.delete/,
    'ADMIN must not hold workspace.delete — this test exists because the UI assumed it did',
  )
  assert.match(page, /canDeleteWorkspace = can\('workspace\.delete'\)|can\('workspace\.delete'\)/, 'the button must be gated on workspace.delete')
})

test('every role in the registry can be assigned from the members list', () => {
  // A VIEWER member used to render a two-option native select with no matching
  // option, displaying "Admin" for a read-only account.
  for (const role of ['ADMIN', 'USER', 'VIEWER']) {
    assert.match(members, new RegExp(`value: '${role}'`), `${role} must be assignable`)
  }
})

test('super admin is a rank in the members select, not a separate console', () => {
  // It used to be a tab of the Reviews console, where nobody looking for "make
  // them an admin" would find it. Members is the one RBAC surface.
  assert.match(members, /value: 'SUPER_ADMIN'/, 'super admin must be an assignable rank')
  assert.match(members, /canManageSuperAdmins/, 'the rank must be gated on holding it')
  // platform.administer, not catalogue.review: granting super admin is an
  // operator action, and a PARTNER-org reviewer holds catalogue.review.
  assert.match(page, /canManageSuperAdmins=\{can\('platform\.administer'\)\}/, 'gated on the permission the routes check')
  // Above Admin: the select is built by prepending it to the ordinary ranks.
  assert.match(members, /\[SUPER_ADMIN_ROLE, \.\.\.ASSIGNABLE_ROLES\]/, 'super admin must sit above admin')
  // And the operator console must not carry the old tab any more.
  const reviews = read('src/app/admin/catalogue/page.tsx')
  assert.doesNotMatch(reviews, /Super admins/, 'the Reviews console must not administer super admins')
})

test('domain access is administered from Settings, not from the Reviews console', () => {
  // Who may sign in is permissions administration; Reviews decides what the
  // catalogue serves. It used to be the "Access" tab there, which is also why
  // /admin/domains now redirects instead of rendering a second copy.
  const platform = read('src/components/settings/platform-section.tsx')
  const access = read('src/components/settings/domain-access-section.tsx')
  assert.match(platform, /<DomainAccessSection \/>/, 'the Platform tab must render domain access')
  assert.match(access, /'\/api\/admin\/domains'/, 'the section must talk to the platform domains route')
  const reviews = read('src/app/admin/catalogue/page.tsx')
  assert.doesNotMatch(reviews, /id: 'access'/, 'the Reviews console must not carry the access tab any more')
  assert.doesNotMatch(reviews, /DomainsPanel|DomainAccessSection/, 'nor render the panel by another route')
  assert.match(read('src/app/admin/domains/page.tsx'), /redirect\('\/settings\?tab=platform'\)/, 'the old URL must still resolve')
})

test('blocking a domain does not decide two things with one native confirm', () => {
  // window.confirm collapsed "block new sign-ins" and "deactivate the accounts
  // already signed in" into OK/Cancel, so Cancel meant block-only, not cancel.
  const access = read('src/components/settings/domain-access-section.tsx')
  assert.doesNotMatch(access, /window\.confirm/, 'the block confirmation must be an in-app dialog')
  assert.match(access, /ConfirmDialog/, 'blocking must confirm through the settings dialog')
  assert.match(access, /deactivateUsers/, 'deactivating the accounts must stay a separate choice')
})

test('the domain TXT challenge is rendered, not only copied', () => {
  // The clipboard write is the ONLY place the token used to go, and it rejects
  // outside a secure context — leaving a claimed domain that could never verify.
  assert.match(security, /dnsValue\(domain\.verificationToken\)/, 'the TXT value must be on screen')
  assert.match(security, /dnsName\(domain\.domain\)/, 'the TXT record name must be on screen')
})

test('credentials that can leak can be revoked from the product', () => {
  assert.match(developer, /'\/api\/api-keys',\s*\{\s*\n?\s*method: 'DELETE'/s, 'API keys must be revocable')
  assert.match(security, /'\/api\/organizations\/scim-tokens',\s*\{\s*\n?\s*method: 'DELETE'/s, 'SCIM tokens must be revocable')
  assert.match(security, /'\/api\/organizations\/domains',\s*\{\s*\n?\s*method: 'DELETE'/s, 'domains must be removable')
})

test('API key scopes are chosen, not hardcoded', () => {
  // flows:run executes flows and bills runs; minting every key with it because
  // the dialog offered nothing else is an exposure, not a convenience.
  assert.doesNotMatch(developer, /scopes: \['flows:read', 'flows:write', 'flows:run'\]/, 'scopes must not be hardcoded')
  assert.match(developer, /const SCOPES/, 'the scope registry must drive the create dialog')
})

test('push notifications can be turned off again', () => {
  assert.match(page, /\/api\/push\/subscribe\?endpoint=/, 'the server-side subscription must be dropped')
  assert.match(page, /sub\.unsubscribe\(\)/, 'the browser subscription must be dropped too')
})

test('MFA enforcement cannot lock the admin who enables it out', () => {
  // mfaPolicy 'required' is enforced by requireAuthContext on nearly every
  // route and assurance comes from having a VERIFIED factor. Before this,
  // nothing in Settings even linked to /auth/mfa.
  assert.match(security, /mfaWouldLockOut/, 'the guard must exist')
  assert.match(security, /href="\/auth\/mfa"/, 'security must offer the enrollment path')
  // Enrollment now lives in MfaSection, rendered on the Account tab beside the
  // profile fields — the account surface must still reach it.
  // `<MfaSection`, not the bare name: an import left behind after the JSX was
  // deleted would satisfy a name match while rendering nothing.
  assert.match(page, /<MfaSection\b/, 'the account tab must render the authenticator section')
  assert.match(mfaSection, /href="\/auth\/mfa"/, 'account must offer the enrollment path')
})

test('removing an authenticator goes through the guarded route, never the browser', () => {
  // Settings used to remove factors with supabase.auth.mfa.unenroll() in a loop.
  // That call answers to Supabase alone, so neither guard could apply to it: a
  // member of a workspace that REQUIRES MFA could strip their only factor from
  // Settings, and a stolen still-warm session could strip someone else's. The
  // contract is that removal has exactly one path, and it is the server's.
  for (const [name, source] of [['settings page', page], ['MFA section', mfaSection], ['security section', security]] as const) {
    assert.doesNotMatch(source, /mfa\s*\.\s*unenroll\s*\(/, `${name} must not unenroll a factor from the browser`)
  }
  assert.match(
    mfaSection,
    /'\/api\/auth\/mfa\/factors',\s*\{\s*\n?\s*method: 'DELETE'/s,
    'removal must call DELETE /api/auth/mfa/factors',
  )
})

test('the last-factor lockout guard is enforced on the server, not by the UI', () => {
  // The disabled button is a courtesy; a hand-rolled fetch has to hit the same
  // rule. Both the list (which tells the UI what is removable) and the deletion
  // decide with removalWouldLockOut, so they can never disagree.
  const route = read('src/app/api/auth/mfa/factors/route.ts')
  assert.match(route, /removalWouldLockOut/, 'the route must apply the lockout rule')
  assert.match(route, /'LAST_FACTOR'/, 'and refuse with a named code')
  assert.match(route, /stepUpSatisfied/, 'a stale session must not be able to remove a factor')
  assert.match(route, /'STEP_UP_REQUIRED'/, 'and be refused with a named code')
  // The UI renders the server's answer rather than recomputing it.
  assert.match(mfaSection, /removable/, 'the section must key its button off the server-supplied flag')
})
