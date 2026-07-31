import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transferUserToOrganization, REVOKED_ON_TRANSFER } from '../org-transfer'

/**
 * The invariant: a user who moves workspaces leaves NOTHING credential-bearing
 * behind in the org they left, and every delete this function issues is scoped
 * to that old org — never the new one, never unscoped.
 */

type Call = { model: string; where: Record<string, unknown> }

function fakeTx(counts: Record<string, number> = {}) {
  const deletes: Call[] = []
  const updates: Call[] = []
  const model = (name: string) => ({
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      deletes.push({ model: name, where })
      return { count: counts[name] ?? 0 }
    },
  })
  const tx = {
    user: {
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push({ model: 'user', where: { ...where, ...data } })
        return {}
      },
    },
    integration: model('integration'),
    peopleAiConnection: model('peopleAiConnection'),
    mcpConnection: model('mcpConnection'),
    pushSubscription: model('pushSubscription'),
  }
  return { tx: tx as never, deletes, updates }
}

const OLD_ORG = 'org-old'
const NEW_ORG = 'org-new'
const USER = 'user-1'

test('moving orgs revokes every per-user credential row, scoped to the org being left', async () => {
  const { tx, deletes, updates } = fakeTx({ integration: 2, peopleAiConnection: 1, mcpConnection: 3, pushSubscription: 1 })

  const result = await transferUserToOrganization(tx, {
    userId: USER,
    fromOrganizationId: OLD_ORG,
    toOrganizationId: NEW_ORG,
    role: 'USER',
  })

  assert.equal(result.moved, true)
  assert.deepEqual(result.revoked, { integration: 2, peopleAiConnection: 1, mcpConnection: 3, pushSubscription: 1 })

  // Every model in the declared set was actually swept — the list and the
  // implementation can't drift apart silently.
  assert.deepEqual(deletes.map((d) => d.model).sort(), [...REVOKED_ON_TRANSFER].sort())

  for (const call of deletes) {
    assert.equal(call.where.organizationId, OLD_ORG, `${call.model} must be scoped to the OLD org`)
    assert.equal(call.where.userId, USER, `${call.model} must be scoped to the moving user`)
  }

  assert.equal(updates.length, 1)
  assert.equal(updates[0].where.organizationId, NEW_ORG)
})

test('transferring into the org the user is already in changes nothing', async () => {
  const { tx, deletes, updates } = fakeTx({ integration: 9 })

  const result = await transferUserToOrganization(tx, {
    userId: USER,
    fromOrganizationId: OLD_ORG,
    toOrganizationId: OLD_ORG,
    role: 'ADMIN',
  })

  assert.equal(result.moved, false)
  assert.deepEqual(deletes, [], 'a re-accepted invite must not revoke a live workspace’s connections')
  assert.deepEqual(updates, [])
})

test('a user with no prior workspace is moved without any revocation', async () => {
  const { tx, deletes, updates } = fakeTx({ integration: 4 })

  const result = await transferUserToOrganization(tx, {
    userId: USER,
    fromOrganizationId: null,
    toOrganizationId: NEW_ORG,
    role: 'ADMIN',
  })

  assert.equal(result.moved, true)
  assert.deepEqual(deletes, [])
  assert.equal(updates.length, 1)
  assert.equal(updates[0].where.organizationId, NEW_ORG)
})

test('the invited role is applied as part of the same move', async () => {
  const { tx, updates } = fakeTx()

  await transferUserToOrganization(tx, {
    userId: USER,
    fromOrganizationId: OLD_ORG,
    toOrganizationId: NEW_ORG,
    role: 'VIEWER',
  })

  assert.equal(updates[0].where.role, 'VIEWER')
})
