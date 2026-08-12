import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Prisma } from '@prisma/client'
import { applyOwnerLiveness, OWNER_LIVENESS_MODELS, UnfilterableCredentialReadError } from '../credential-owner-guard'

const LIVENESS = { OR: [{ userId: null }, { user: { is: { isActive: true } } }] }

test('a credential read gains the owner-liveness filter', () => {
  const args = applyOwnerLiveness('McpConnection', 'findMany', { where: { organizationId: 'org-1' } })

  assert.deepEqual(args, { where: { AND: [{ organizationId: 'org-1' }, LIVENESS] } })
})

test('a read with no where clause still gets filtered', () => {
  // Otherwise the least-scoped query in the codebase is the one that leaks.
  const args = applyOwnerLiveness('Integration', 'findMany', {})

  assert.deepEqual(args, { where: LIVENESS })
})

test('models outside the registry are untouched', () => {
  // HttpCredential and IntegrationSecret are workspace-owned and have no userId.
  // Filtering them would break the org when any one person leaves.
  const original = { where: { organizationId: 'org-1' } }

  assert.equal(applyOwnerLiveness('HttpCredential', 'findMany', original), original)
  assert.equal(applyOwnerLiveness('Flow', 'findMany', original), original)
})

test('writes are untouched — this layer prevents USE, not removal', () => {
  // revokeUserAccess must be able to delete these rows, and the sweeper updates
  // them. Layer 2 handles removal; filtering writes here would fight it.
  const original = { where: { id: 'row-1' }, data: { isActive: false } }

  assert.equal(applyOwnerLiveness('McpConnection', 'update', original), original)
  assert.equal(applyOwnerLiveness('McpConnection', 'deleteMany', original), original)
})

test('findUnique on a registry model throws rather than silently skipping the filter', () => {
  // findUnique accepts only unique fields in `where`, so the filter cannot be
  // injected. Failing loudly is the whole point: a silent pass-through would
  // leave a hole exactly where the People.ai OAuth tokens are read.
  assert.throws(
    () => applyOwnerLiveness('PeopleAiConnection', 'findUnique', { where: { id: 'x' } }),
    UnfilterableCredentialReadError,
  )
})

test('the registry is exactly the four user-owned credential models', () => {
  assert.deepEqual(
    [...OWNER_LIVENESS_MODELS].sort(),
    ['Integration', 'McpConnection', 'NangoConnection', 'PeopleAiConnection'],
  )
})

test('no model gains a user-owned credential shape without joining the registry', () => {
  // The regression net. A new per-user credential model added in six months
  // would otherwise be silently exempt from the invariant — which is exactly how
  // deactivation ended up exempt from the revocation logic in the first place.
  const CREDENTIAL_FIELD = /^(accessToken|refreshToken|authConfig|apiKey|secret|credentials)$/i

  const candidates = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((f) => f.name === 'userId'))
    .filter((model) => model.fields.some((f) => CREDENTIAL_FIELD.test(f.name)))
    .map((model) => model.name)

  const unregistered = candidates.filter((name) => !OWNER_LIVENESS_MODELS.has(name))

  assert.deepEqual(
    unregistered,
    [],
    `these models carry a userId and a credential but are not in OWNER_LIVENESS_MODELS: ${unregistered.join(', ')}. ` +
      `Add them to the registry, or document why the credential survives its owner.`,
  )
})

test('no source file reads a registry model through findUnique on the guarded client', () => {
  // The runtime throw only fires if that code path executes. This fails the test
  // run instead — the People.ai tokens are the highest-value read in the
  // codebase and a silent hole there is the worst case.
  const models = 'integration|peopleAiConnection|mcpConnection|nangoConnection'
  const pattern = new RegExp(`(?<!system)[Pp]risma\\.(${models})\\.findUnique`)

  const offenders = execSync(`find src -type f -name '*.ts' -not -path '*__tests__*'`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))

  assert.deepEqual(
    offenders,
    [],
    `these files read a user-owned credential via findUnique, which cannot carry the ` +
      `owner-liveness filter: ${offenders.join(', ')}. Rewrite them as findFirst.`,
  )
})
