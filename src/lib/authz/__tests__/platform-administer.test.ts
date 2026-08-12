import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolvePermissions } from '../permissions'

/**
 * platform.administer is the operator tier, and the reason it exists is that
 * catalogue.review is NOT it.
 *
 * A reviewer in a PARTNER workspace holds catalogue.review — that is deliberate,
 * partners moderate shared catalogue content. The operator console is a
 * different thing: cross-workspace spend, every user's personal details, and
 * password/deactivation actions. These tests hold that line, because the two
 * permissions look interchangeable at a call site and are not.
 */

const OWNER_EMAIL = 'james.mcdaniel@people.ai'

const resolve = (
  user: { role?: 'OWNER' | 'ADMIN' | 'USER' | 'VIEWER'; platformRole?: string | null; email?: string | null },
  kind: string,
) =>
  resolvePermissions(
    { role: user.role ?? 'USER', platformRole: user.platformRole ?? null, email: user.email ?? null },
    { kind },
  )

test('an internal reviewer is a platform operator', () => {
  const permissions = resolve({ platformRole: 'reviewer' }, 'internal')
  assert.ok(permissions.has('platform.administer'))
  assert.ok(permissions.has('catalogue.review'), 'and still reviews the catalogue')
})

test('a PARTNER reviewer reviews the catalogue but is not an operator', () => {
  // The whole point of the split. If this ever flips, a partner organisation
  // gains every platform user's email, last-login, and the ability to
  // deactivate them.
  const permissions = resolve({ platformRole: 'reviewer' }, 'partner')
  assert.ok(permissions.has('catalogue.review'), 'partners do moderate the catalogue')
  assert.equal(permissions.has('platform.administer'), false)
})

test('the platform owner is an operator from any workspace', () => {
  for (const kind of ['internal', 'partner', 'customer']) {
    assert.ok(
      resolve({ role: 'OWNER', email: OWNER_EMAIL }, kind).has('platform.administer'),
      `owner should hold it in a ${kind} workspace`,
    )
  }
})

test('no ordinary role reaches it, however senior, in any workspace kind', () => {
  for (const kind of ['internal', 'partner', 'customer']) {
    for (const role of ['ADMIN', 'USER', 'VIEWER'] as const) {
      assert.equal(
        resolve({ role }, kind).has('platform.administer'),
        false,
        `${role} in a ${kind} workspace must not hold platform.administer`,
      )
    }
  }
})

test('a reviewer in a CUSTOMER workspace holds neither', () => {
  // The flag alone is never enough — this is what makes moving a reviewer into
  // a customer workspace revoke their rights without anyone clearing the column.
  const permissions = resolve({ platformRole: 'reviewer' }, 'customer')
  assert.equal(permissions.has('platform.administer'), false)
  assert.equal(permissions.has('catalogue.review'), false)
})

test('the staff marker is not the operator tier', () => {
  assert.equal(resolve({ platformRole: 'staff' }, 'internal').has('platform.administer'), false)
})

/**
 * The registry only decides who HOLDS the permission. This walks the operator
 * routes and asserts each one actually asks for it — a new sibling route that
 * forgets the gate, or reverts to catalogue.review, fails here rather than
 * shipping an open door.
 */
test('every /api/admin route is gated on platform.administer and internalOnly', () => {
  const adminApi = path.join(process.cwd(), 'src/app/api/admin')
  const routes: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'route.ts' && statSync(full).isFile()) routes.push(full)
    }
  }
  walk(adminApi)

  assert.ok(routes.length >= 3, `expected the admin routes to be found, saw ${routes.length}`)
  for (const route of routes) {
    const source = readFileSync(route, 'utf8')
    const relative = path.relative(process.cwd(), route)
    assert.match(source, /permission: 'platform\.administer'/, `${relative} must require platform.administer`)
    assert.doesNotMatch(
      source,
      /permission: 'catalogue\.review'/,
      `${relative} must not fall back to catalogue.review — a partner reviewer holds that`,
    )
    assert.match(source, /internalOnly: true/, `${relative} must be absent from the customer edition`)
  }
})

test('the super-admin grant paths require the operator tier', () => {
  // Granting super admin from a weaker permission would let a partner reviewer
  // mint operators and reach the console indirectly.
  for (const file of [
    'src/app/api/organizations/members/[id]/route.ts',
    'src/app/api/catalogue/staff/route.ts',
  ]) {
    const source = readFileSync(file, 'utf8')
    assert.match(source, /platform\.administer/, `${file} must gate super-admin grants on platform.administer`)
  }
})

test('the Users nav entry and page are gated on the operator tier', () => {
  const sidebar = readFileSync('src/components/layout/sidebar.tsx', 'utf8')
  assert.match(sidebar, /can\('platform\.administer'\).*usersNavItem|usersNavItem/s)
  assert.match(sidebar, /can\('platform\.administer'\)/, 'the Users entry must be permission-gated')
})
