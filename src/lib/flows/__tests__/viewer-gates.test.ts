import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serializeFlow } from '@/lib/flows/serialize'
import { flowCardActions, viewOnlyNotice } from '@/lib/flows/viewer-gates'
import { canChangeFlowSharing } from '@/lib/flows/access'

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'f1',
  name: 'Demo',
  description: '',
  status: 'DRAFT',
  trigger: { type: 'manual' },
  graph: { nodes: [], edges: [] },
  visibility: 'shared',
  userId: 'owner',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...extra,
})

describe('serializeFlow canEdit', () => {
  /**
   * The sharing role alone said 'edit' to a VIEWER member on a shared flow,
   * and that one fact drove the editor, jam presence and the persister
   * election — so their autosaves 403'd silently and real editors stopped
   * persisting. The permission is part of the fact now.
   */
  it('is false for an edit role without flow.write', () => {
    const flow = serializeFlow(row(), 'viewer', { role: 'edit', external: false, canWrite: false })
    assert.equal(flow.canEdit, false)
  })

  it('is true only when the role is edit AND the caller holds flow.write', () => {
    assert.equal(serializeFlow(row(), 'member', { role: 'edit', external: false, canWrite: true }).canEdit, true)
    assert.equal(serializeFlow(row(), 'member', { role: 'view', external: false, canWrite: true }).canEdit, false)
  })

  it('keeps the legacy derivations for callers that pass no access', () => {
    // After a write the caller already passed flow.write at the gate.
    assert.equal(serializeFlow(row()).canEdit, true)
    // v1 org-only derivation: a 'view' flow is the owner's to edit.
    assert.equal(serializeFlow(row({ visibility: 'view' }), 'someone').canEdit, false)
    assert.equal(serializeFlow(row({ visibility: 'view' }), 'owner').canEdit, true)
  })
})

describe('serializeFlow canChangeSharing', () => {
  it('is the owner’s alone on an owned flow', () => {
    const access = { role: 'edit' as const, external: false, canWrite: true }
    assert.equal(serializeFlow(row(), 'owner', access).canChangeSharing, true)
    assert.equal(serializeFlow(row(), 'member', access).canChangeSharing, false)
  })

  it('stays with the editors of a legacy ownerless flow', () => {
    const flow = serializeFlow(row({ userId: null }), 'member', { role: 'edit', external: false, canWrite: true })
    assert.equal(flow.canChangeSharing, true)
  })

  it('is never offered to a guest or to someone who cannot edit', () => {
    assert.equal(serializeFlow(row(), 'owner', { role: 'edit', external: true, canWrite: true }).canChangeSharing, false)
    assert.equal(serializeFlow(row({ userId: null }), 'v', { role: 'edit', external: false, canWrite: false }).canChangeSharing, false)
  })

  it('matches the rule the PUT enforces', () => {
    assert.equal(canChangeFlowSharing({ userId: 'owner' }, 'owner'), true)
    assert.equal(canChangeFlowSharing({ userId: 'owner' }, 'member'), false)
    assert.equal(canChangeFlowSharing({ userId: null }, 'member'), true)
  })
})

describe('flowCardActions', () => {
  it('offers edits only on a flow the viewer can edit in their own workspace', () => {
    const editable = flowCardActions({ canEdit: true }, true)
    assert.deepEqual(editable, { edit: true, publish: true, move: true, delete: true, duplicate: true })

    const viewOnly = flowCardActions({ canEdit: false }, true)
    assert.equal(viewOnly.edit || viewOnly.publish || viewOnly.move || viewOnly.delete, false)
    assert.equal(viewOnly.duplicate, true, 'a copy is a NEW flow, theirs to make')

    const guest = flowCardActions({ canEdit: true, external: true }, true)
    assert.equal(guest.edit || guest.publish || guest.move || guest.delete, false, 'org-scoped writes 404 for a guest')
  })

  it('fails closed when the server said nothing', () => {
    assert.equal(flowCardActions({}, true).delete, false)
  })

  it('withholds duplicate from a role that cannot create flows', () => {
    assert.equal(flowCardActions({ canEdit: false }, false).duplicate, false)
  })
})

describe('viewOnlyNotice', () => {
  it('sends a role-limited viewer to an admin, not to the owner', () => {
    assert.match(viewOnlyNotice({ canWriteFlows: false, canRun: false }), /admin/i)
    assert.doesNotMatch(viewOnlyNotice({ canWriteFlows: false, canRun: false }), /can run/i)
  })

  it('keeps the owner wording for a view-shared flow', () => {
    assert.match(viewOnlyNotice({ canWriteFlows: true, canRun: true }), /only its owner can edit/i)
  })
})
