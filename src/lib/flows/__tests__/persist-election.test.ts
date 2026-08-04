import { test } from 'node:test'
import assert from 'node:assert/strict'
import { electPersister, shouldPersistGraph } from '@/lib/flows/collab-roles'

/**
 * Graph autosave must not depend on realtime presence being up.
 *
 * The builder persists graph edits automatically — only name/description/status
 * need the Save button — and it picks ONE writer during a jam so peers don't
 * race the optimistic lock. But the elected writer was chosen purely from the
 * realtime presence roster, which starts empty and STAYS empty when the jam
 * channel can't subscribe (it fails closed, with no public fallback). An empty
 * roster elects nobody, so `isPersister` was false and the autosave effect
 * returned early: a solo editor's canvas changes were never written.
 *
 * Dragging a node was the visible symptom — a drag is a direct manipulation
 * with no dirty-state prompt, so the position was silently discarded on
 * navigation and the node reappeared at its dagre-computed spot.
 */

const me = { clientId: 'c-me', userId: 'u-me', canEdit: true }
const teammate = { clientId: 'c-aa', userId: 'u-teammate', canEdit: true }
const owner = { clientId: 'c-zz', userId: 'u-owner', canEdit: true }

test('an empty roster still elects the local editor — realtime being down cannot disable autosave', () => {
  assert.equal(
    electPersister([], 'u-owner'),
    null,
    'the jam election itself has nobody to pick, which is correct',
  )
  assert.equal(
    shouldPersistGraph({ roster: [], selfClientId: 'c-me', selfUserId: 'u-me', canEdit: true, ownerId: 'u-owner' }),
    true,
    'but the local editor persists its own work when presence reports nothing',
  )
})

test('a view-only viewer never persists, roster or not', () => {
  assert.equal(
    shouldPersistGraph({ roster: [], selfClientId: 'c-me', selfUserId: 'u-me', canEdit: false, ownerId: 'u-owner' }),
    false,
  )
  assert.equal(
    shouldPersistGraph({ roster: [{ ...me, canEdit: false }], selfClientId: 'c-me', selfUserId: 'u-me', canEdit: false, ownerId: null }),
    false,
  )
})

test('with presence up, exactly one peer in a jam persists — unchanged from the jam contract', () => {
  const roster = [me, teammate, owner]
  const elected = roster.filter((p) =>
    shouldPersistGraph({ roster, selfClientId: p.clientId, selfUserId: p.userId, canEdit: true, ownerId: 'u-owner' }),
  )
  assert.equal(elected.length, 1, 'exactly one writer')
  assert.equal(elected[0].clientId, 'c-zz', 'and it is the owner, per the election rule')
})

test('order does not matter — every peer computes the same answer from its own snapshot', () => {
  const a = [me, teammate]
  const b = [teammate, me]
  for (const self of a) {
    assert.equal(
      shouldPersistGraph({ roster: a, selfClientId: self.clientId, selfUserId: self.userId, canEdit: true, ownerId: null }),
      shouldPersistGraph({ roster: b, selfClientId: self.clientId, selfUserId: self.userId, canEdit: true, ownerId: null }),
    )
  }
})

test('a roster that has not yet included us does not hand the write to a teammate we cannot see', () => {
  // Presence delivered someone else first. They are a real peer, so the normal
  // election applies and we defer — no double writer.
  assert.equal(
    shouldPersistGraph({ roster: [teammate], selfClientId: 'c-me', selfUserId: 'u-me', canEdit: true, ownerId: null }),
    false,
  )
})
