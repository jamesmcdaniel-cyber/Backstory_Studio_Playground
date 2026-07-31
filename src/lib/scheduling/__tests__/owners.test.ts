import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attributeOwners } from '../owners'

const ORG_A = 'org-a'
const ORG_B = 'org-b'

test('a named owner who is still in the org is used', () => {
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-1' }],
    [{ id: 'user-1', organizationId: ORG_A }],
    [{ id: 'user-oldest', organizationId: ORG_A }],
  )

  assert.equal(owners.get('agent-1'), 'user-1')
})

test('an ownerless row falls back to the org’s oldest active member', () => {
  const owners = attributeOwners(
    [{ id: 'flow-1', organizationId: ORG_A, userId: null }],
    [],
    // Ordered oldest-first by the caller's query.
    [{ id: 'user-oldest', organizationId: ORG_A }, { id: 'user-newer', organizationId: ORG_A }],
  )

  assert.equal(owners.get('flow-1'), 'user-oldest')
})

test('a named owner who LEFT the org is not used — the run re-attributes to the org', () => {
  // The exact cross-workspace hazard: agent still carries userId, but that user
  // now belongs to org B. Crediting them would run org A's agent as an outsider.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-moved' }],
    [{ id: 'user-moved', organizationId: ORG_B }],
    [{ id: 'user-a-oldest', organizationId: ORG_A }],
  )

  assert.equal(owners.get('agent-1'), 'user-a-oldest')
})

test('a named owner who is deactivated falls back too', () => {
  // Deactivated users are filtered out of the query, so they never appear in
  // explicitOwners — the fallback must cover that, not crash or attribute them.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-gone' }],
    [],
    [{ id: 'user-a-oldest', organizationId: ORG_A }],
  )

  assert.equal(owners.get('agent-1'), 'user-a-oldest')
})

test('a candidate whose org has no active member is omitted, not guessed', () => {
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: null }],
    [],
    [{ id: 'user-b', organizationId: ORG_B }],
  )

  assert.equal(owners.has('agent-1'), false, 'callers skip these; an unattributable run must not be created')
})

test('candidates across many orgs each resolve against their own org', () => {
  const owners = attributeOwners(
    [
      { id: 'a1', organizationId: ORG_A, userId: null },
      { id: 'b1', organizationId: ORG_B, userId: 'user-b1' },
      { id: 'b2', organizationId: ORG_B, userId: null },
    ],
    [{ id: 'user-b1', organizationId: ORG_B }],
    [
      { id: 'user-a-oldest', organizationId: ORG_A },
      { id: 'user-b-oldest', organizationId: ORG_B },
    ],
  )

  assert.equal(owners.get('a1'), 'user-a-oldest')
  assert.equal(owners.get('b1'), 'user-b1')
  assert.equal(owners.get('b2'), 'user-b-oldest')
})
