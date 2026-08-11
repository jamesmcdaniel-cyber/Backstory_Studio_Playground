import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preparePhase } from '../dispatch-tick'

/**
 * The regression these guard: OrgCapacity.forOrgs and resolveRunOwners sat
 * OUTSIDE every try/catch in the dispatch handler. A Prisma pool exhaustion in
 * the agent phase's prep escaped to the outer catch and took down flow
 * dispatch, wait resumes, and the template sweep for the whole tick — one
 * transient failure silently skipping every scheduled flow on the platform.
 */

const capacityStub = { tryClaim: () => true, saturatedOrgs: () => [] } as never

test('a throwing capacity read degrades one phase instead of aborting the tick', async () => {
  const result = await preparePhase('agent', [], {
    forOrgs: async () => {
      throw new Error('pool exhausted')
    },
    resolveRunOwners: async () => new Map(),
  })
  assert.equal(result, null)
})

test('a throwing owner resolution degrades the same way', async () => {
  const result = await preparePhase('flow', [], {
    forOrgs: async () => capacityStub,
    resolveRunOwners: async () => {
      throw new Error('db down')
    },
  })
  assert.equal(result, null)
})

test('a healthy prep returns both the capacity and the owner map', async () => {
  const owners = new Map([['flow-1', 'user-1']])
  const result = await preparePhase('flow', [], {
    forOrgs: async () => capacityStub,
    resolveRunOwners: async () => owners,
  })
  assert.deepEqual(result, { capacity: capacityStub, owners })
})

test('the capacity read is given one entry per DISTINCT org, not one per row', async () => {
  let received: string[] = []
  await preparePhase(
    'flow',
    [
      { id: 'a', organizationId: 'org-1', userId: null },
      { id: 'b', organizationId: 'org-1', userId: null },
      { id: 'c', organizationId: 'org-2', userId: null },
    ],
    {
      forOrgs: async (orgs) => {
        received = orgs
        return capacityStub
      },
      resolveRunOwners: async () => new Map(),
    },
  )
  assert.deepEqual([...received].sort(), ['org-1', 'org-2'])
})
