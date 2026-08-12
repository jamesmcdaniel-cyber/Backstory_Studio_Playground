import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attributeOwners } from '../owners'

const ORG_A = 'org-a'
const ORG_B = 'org-b'

test('a named owner who is still in the org is used', () => {
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-1' }],
    [{ id: 'user-1', organizationId: ORG_A, isActive: true }],
    [{ id: 'user-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('agent-1'), 'user-1')
})

test('an ownerless row falls back to the org’s oldest active member', () => {
  const owners = attributeOwners(
    [{ id: 'flow-1', organizationId: ORG_A, userId: null }],
    [],
    // Ordered oldest-first by the caller's query.
    [{ id: 'user-oldest', organizationId: ORG_A, isActive: true }, { id: 'user-newer', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('flow-1'), 'user-oldest')
})

test('a named owner who LEFT the org is not used — the run re-attributes to the org', () => {
  // The exact cross-workspace hazard: agent still carries userId, but that user
  // now belongs to org B. Crediting them would run org A's agent as an outsider.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-moved' }],
    [{ id: 'user-moved', organizationId: ORG_B, isActive: true }],
    [{ id: 'user-a-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('agent-1'), 'user-a-oldest')
})

test('a named owner whose user row is absent entirely falls back', () => {
  // Not the deactivation case — this is a dangling userId with no row at all.
  // (This test used to be labelled "deactivated", which it never actually
  // exercised: a deactivated owner was filtered out of the query upstream, so
  // it arrived here indistinguishable from a missing row. That ambiguity is
  // what let a suspended person's work keep running under someone else.)
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-gone' }],
    [],
    [{ id: 'user-a-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('agent-1'), 'user-a-oldest')
})

test('a named owner who was DEACTIVATED quarantines the row — it does not re-attribute', () => {
  // The core of the revocation spine: a suspended person's scheduled work must
  // stop, not silently continue under a colleague's identity.
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: 'user-suspended' }],
    [{ id: 'user-suspended', organizationId: ORG_A, isActive: false }],
    [{ id: 'user-a-oldest', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.has('agent-1'), false, 'callers skip absent candidates, so the work does not dispatch')
})

test('a deactivated member is never the fallback owner either', () => {
  // The fallback list is queried with isActive already filtered, but the rule
  // belongs in the pure function too — otherwise the only thing standing
  // between a suspended person and a run is a where clause two files away.
  const owners = attributeOwners(
    [{ id: 'flow-1', organizationId: ORG_A, userId: null }],
    [],
    [{ id: 'user-suspended', organizationId: ORG_A, isActive: false }, { id: 'user-active', organizationId: ORG_A, isActive: true }],
  )

  assert.equal(owners.get('flow-1'), 'user-active')
})

test('a candidate whose org has no active member is omitted, not guessed', () => {
  const owners = attributeOwners(
    [{ id: 'agent-1', organizationId: ORG_A, userId: null }],
    [],
    [{ id: 'user-b', organizationId: ORG_B, isActive: true }],
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
    [{ id: 'user-b1', organizationId: ORG_B, isActive: true }],
    [
      { id: 'user-a-oldest', organizationId: ORG_A, isActive: true },
      { id: 'user-b-oldest', organizationId: ORG_B, isActive: true },
    ],
  )

  assert.equal(owners.get('a1'), 'user-a-oldest')
  assert.equal(owners.get('b1'), 'user-b1')
  assert.equal(owners.get('b2'), 'user-b-oldest')
})
