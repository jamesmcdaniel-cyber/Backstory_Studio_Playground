import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isSnapshotMutation,
  organizationIdForSnapshotBump,
  SNAPSHOT_MODELS,
} from '@/lib/server/snapshot-version'

describe('isSnapshotMutation', () => {
  it('matches writes to models the shell reads', () => {
    assert.equal(isSnapshotMutation('AgentTask', 'update'), true)
    assert.equal(isSnapshotMutation('AgentExecution', 'create'), true)
    assert.equal(isSnapshotMutation('Notification', 'updateMany'), true)
    assert.equal(isSnapshotMutation('LlmCall', 'create'), true)
  })

  it('ignores reads — a validator that moved on every SELECT would never match', () => {
    for (const operation of ['findMany', 'findFirst', 'findUnique', 'count', 'groupBy', 'aggregate']) {
      assert.equal(isSnapshotMutation('AgentTask', operation), false, operation)
    }
  })

  it('ignores writes to models the shell does not read', () => {
    // A flow autosave is one PUT every 2s per editing user. Bumping on it would
    // invalidate every OTHER member's shell for data none of them can see.
    assert.equal(isSnapshotMutation('Flow', 'update'), false)
    assert.equal(isSnapshotMutation('FlowRunStep', 'create'), false)
    assert.equal(isSnapshotMutation(undefined, 'update'), false)
  })

  it('covers every operation Prisma can use to change a row', () => {
    for (const operation of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']) {
      assert.equal(isSnapshotMutation('AgentTask', operation), true, operation)
    }
  })
})

describe('organizationIdForSnapshotBump', () => {
  it('reads the scope the tenant guard already required', () => {
    assert.equal(
      organizationIdForSnapshotBump('AgentTask', { where: { organizationId: 'org_1' } }, undefined),
      'org_1',
    )
  })

  it('reads it from the data on a create, which carries no where', () => {
    assert.equal(
      organizationIdForSnapshotBump('AgentExecution', { data: { organizationId: 'org_2' } }, undefined),
      'org_2',
    )
  })

  it('keys Organization on its OWN id — it does not carry an organizationId', () => {
    assert.equal(organizationIdForSnapshotBump('Organization', { where: { id: 'org_3' } }, undefined), 'org_3')
  })

  it('falls back to the ambient organization when the args carry no scope', () => {
    // The parent-scoped path: a write routed by id alone, inside a request whose
    // workspace the API wrapper already established.
    assert.equal(organizationIdForSnapshotBump('AgentExecution', { where: { id: 'exec_1' } }, 'org_4'), 'org_4')
  })

  it('returns undefined when neither the args nor the context name a workspace', () => {
    // Better than guessing: the caller turns this into a no-op bump rather than
    // advancing some other workspace's counter.
    assert.equal(organizationIdForSnapshotBump('AgentExecution', { where: { id: 'exec_1' } }, undefined), undefined)
  })

  it('does not mistake a createMany array payload for a scoped write', () => {
    const result = organizationIdForSnapshotBump('Notification', { data: [{ organizationId: 'org_5' }] }, 'org_6')
    assert.equal(result, 'org_6')
  })
})

describe('SNAPSHOT_MODELS', () => {
  it('names every model the snapshot route queries', () => {
    // Guards the coupling that is easy to break from the other side: adding a
    // query to /api/snapshot without adding its model here produces a shell
    // that silently stops updating for that data.
    for (const model of ['AgentTask', 'AgentExecution', 'Notification', 'Organization', 'WorkspaceFolder', 'LlmCall']) {
      assert.ok(SNAPSHOT_MODELS.has(model), `${model} missing`)
    }
  })
})
