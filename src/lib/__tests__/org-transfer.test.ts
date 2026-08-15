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
  /** updateMany calls made by the shared revocation, kept out of `updates`. */
  const bulkUpdates: Call[] = []

  const model = (name: string) => ({
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      deletes.push({ model: name, where })
      return { count: counts[name] ?? 0 }
    },
  })
  const bulkUpdatable = (name: string) => ({
    updateMany: async ({ where }: { where: Record<string, unknown> }) => {
      bulkUpdates.push({ model: name, where })
      return { count: 0 }
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
    // Reads its rows before deleting them, so the caller can revoke the grants
    // upstream: deprovisioning enqueues that list, a transfer discards it.
    nangoConnection: { ...model('nangoConnection'), findMany: async () => [] },
    httpCredential: model('httpCredential'),
    pushSubscription: model('pushSubscription'),
    apiKey: bulkUpdatable('apiKey'),
    flow: bulkUpdatable('flow'),
    agentTask: bulkUpdatable('agentTask'),
  }
  return { tx: tx as never, deletes, updates, bulkUpdates }
}

const OLD_ORG = 'org-old'
const NEW_ORG = 'org-new'
const USER = 'user-1'

test('moving orgs revokes every per-user credential row, scoped to the org being left', async () => {
  const { tx, deletes, updates, bulkUpdates } = fakeTx({
    integration: 2,
    peopleAiConnection: 1,
    mcpConnection: 3,
    nangoConnection: 2,
    httpCredential: 1,
    pushSubscription: 1,
  })

  const result = await transferUserToOrganization(tx, {
    userId: USER,
    fromOrganizationId: OLD_ORG,
    toOrganizationId: NEW_ORG,
    role: 'USER',
  })

  assert.equal(result.moved, true)
  assert.deepEqual(result.revoked, {
    integration: 2,
    peopleAiConnection: 1,
    mcpConnection: 3,
    nangoConnection: 2,
    httpCredential: 1,
    pushSubscription: 1,
  })

  // Every model in the declared set was actually swept — the list and the
  // implementation can't drift apart silently.
  assert.deepEqual(deletes.map((d) => d.model).sort(), [...REVOKED_ON_TRANSFER].sort())

  for (const call of deletes) {
    assert.equal(call.where.organizationId, OLD_ORG, `${call.model} must be scoped to the OLD org`)
    assert.equal(call.where.userId, USER, `${call.model} must be scoped to the moving user`)
  }

  assert.equal(updates.length, 1)
  assert.equal(updates[0].where.organizationId, NEW_ORG)

  // A transfer is not a deprovisioning. The shared revocation quarantines,
  // because its usual caller is a suspension — so a transfer must clear the
  // stamp back off, or moving workspaces would silently stop the flows the
  // person still owns in the org they left.
  const workUpdates = bulkUpdates.filter((call) => call.model === 'flow' || call.model === 'agentTask')
  assert.equal(workUpdates.length, 4, 'flow and agentTask are each stamped, then cleared')
  for (const call of workUpdates) {
    assert.equal(call.where.organizationId, OLD_ORG, `${call.model} must stay scoped to the OLD org`)
    assert.equal(call.where.userId, USER)
  }
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
