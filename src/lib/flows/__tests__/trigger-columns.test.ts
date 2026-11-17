import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import type { FlowGraph } from '@/lib/flows/graph'
import { pollIdentity, pollIdentityChanged, triggerDraftDiff, triggerTypeLabel } from '@/lib/flows/trigger'
import { draftTriggerColumns, draftGraphTriggerColumns, publishedTriggerColumns } from '@/lib/flows/trigger-columns'

/**
 * Flow.trigger (+ activitySource/activityKinds) is what every firing path
 * reads, and every one of them runs publishedGraph — so while a flow is
 * published, only publish may change those columns. These pin the helpers
 * every write site goes through.
 */

const graphWith = (trigger: Record<string, unknown>): FlowGraph =>
  ({ nodes: [{ id: 'trigger', type: 'trigger', data: { trigger } }], edges: [] }) as unknown as FlowGraph

const poll = (overrides: Record<string, unknown> = {}) => ({
  type: 'poll',
  connectionId: 'conn-1',
  toolName: 'list_issues',
  schedule: { type: 'hourly', isActive: true },
  ...overrides,
})

test('pollIdentity covers what the cursor is a cursor of, and nothing else', () => {
  assert.equal(pollIdentity({ type: 'manual' }), null)
  assert.equal(pollIdentity(undefined), null)
  // Cadence and emit mode don't change which items count as seen.
  assert.equal(
    pollIdentity(poll({ schedule: { type: 'daily', time: '09:00' }, emit: 'batch' })),
    pollIdentity(poll()),
  )
  // The dispatcher keys on 'id' when no id field is set.
  assert.equal(pollIdentity(poll({ dedupeKey: 'id' })), pollIdentity(poll()))
  // Args are compared as JSON, not as text.
  assert.equal(pollIdentity(poll({ args: '{"a":1,"b":2}' })), pollIdentity(poll({ args: '{ "b": 2, "a": 1 }' })))
  assert.equal(pollIdentity(poll({ args: '{}' })), pollIdentity(poll()))
  for (const change of [{ connectionId: 'conn-2' }, { toolName: 'list_prs' }, { args: '{"state":"open"}' }, { itemsPath: 'data' }, { dedupeKey: 'number' }]) {
    assert.ok(pollIdentityChanged(poll(), poll(change)), `changing ${Object.keys(change)[0]} resets the cursor`)
  }
})

test('switching away from a poll and back counts as a change each way', () => {
  assert.ok(pollIdentityChanged(poll(), { type: 'webhook' }))
  assert.ok(pollIdentityChanged({ type: 'webhook' }, poll()))
  assert.ok(!pollIdentityChanged({ type: 'webhook' }, { type: 'schedule' }), 'no poll on either side, no cursor to drop')
})

test('a published flow: a draft write leaves every trigger column alone', () => {
  const existing = { trigger: { type: 'webhook', webhookSecretHash: 'hash' }, publishedGraph: graphWith({ type: 'webhook' }) }
  assert.equal(draftTriggerColumns({ type: 'schedule', schedule: { type: 'daily', time: '09:00' } }, existing), null)
  assert.equal(draftGraphTriggerColumns(graphWith(poll()), existing), null)
})

test('an unpublished flow: the columns follow the draft, keeping the secret hash and an unchanged anchor', () => {
  const schedule = { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true, anchor: '2026-01-01T00:00:00.000Z' }
  const existing = { trigger: { type: 'schedule', schedule, webhookSecretHash: 'hash' }, publishedGraph: null }
  const columns = draftGraphTriggerColumns(graphWith({ type: 'schedule', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } }), existing)
  assert.ok(columns)
  const trigger = columns.trigger as Record<string, any>
  assert.equal(trigger.webhookSecretHash, 'hash', 'the client never holds the hash, so a save must keep it')
  assert.equal(trigger.schedule.anchor, schedule.anchor, 'an unchanged schedule keeps its anchor')
  assert.equal(columns.activitySource, null)
  assert.equal(columns.pollCursor, undefined, 'no poll involved, cursor untouched')

  const moved = draftGraphTriggerColumns(graphWith({ type: 'schedule', schedule: { type: 'daily', time: '10:00', timezone: 'UTC', isActive: true } }), existing)
  assert.notEqual((moved!.trigger as any).schedule.anchor, schedule.anchor, 'a changed schedule is re-anchored')
})

test('an unpublished flow: the draft write drops the poll cursor exactly when the poll read changes', () => {
  const existing = { trigger: poll(), publishedGraph: null }
  assert.equal(draftGraphTriggerColumns(graphWith(poll({ emit: 'batch' })), existing)!.pollCursor, undefined)
  assert.equal(draftGraphTriggerColumns(graphWith(poll({ toolName: 'list_prs' })), existing)!.pollCursor, Prisma.DbNull)
  assert.equal(draftGraphTriggerColumns(graphWith({ type: 'manual' }), existing)!.pollCursor, Prisma.DbNull)
})

test('event triggers write the activity match columns from the trigger that will fire', () => {
  const columns = draftGraphTriggerColumns(graphWith({ type: 'activity', source: 'github', kinds: ['pr.opened'] }), { trigger: {}, publishedGraph: null })
  assert.equal(columns!.activitySource, 'github')
  assert.deepEqual(columns!.activityKinds, ['pr.opened'])
})

test('publishing arms the published graph trigger: fresh anchor and fresh poll baseline when arming', () => {
  const existing = { trigger: poll({ schedule: { type: 'hourly', isActive: true, anchor: '2026-01-01T00:00:00.000Z' } }), publishedGraph: null }
  const { trigger, columns } = publishedTriggerColumns(graphWith(poll()), existing)
  assert.notEqual((trigger.schedule as any).anchor, '2026-01-01T00:00:00.000Z', 'first arm anchors at now — no catch-up run')
  assert.equal(columns.pollCursor, Prisma.DbNull, 'arming a poll baselines it, even on the same read')
})

test('republishing keeps the anchor and cursor unless what fires changed', () => {
  const live = poll({ schedule: { type: 'hourly', isActive: true, anchor: '2026-01-01T00:00:00.000Z' }, webhookSecretHash: 'hash' })
  const existing = { trigger: live, publishedGraph: graphWith(poll()) }
  const same = publishedTriggerColumns(graphWith(poll({ schedule: { type: 'hourly', isActive: true } })), existing)
  assert.equal((same.trigger.schedule as any).anchor, '2026-01-01T00:00:00.000Z')
  assert.equal(same.trigger.webhookSecretHash, 'hash')
  assert.equal(same.columns.pollCursor, undefined)

  const changed = publishedTriggerColumns(graphWith(poll({ itemsPath: 'items' })), existing)
  assert.equal(changed.columns.pollCursor, Prisma.DbNull, 'a new read baselines instead of flooding')

  const webhook = publishedTriggerColumns(graphWith({ type: 'webhook' }), existing)
  assert.equal(webhook.trigger.type, 'webhook')
  assert.equal(webhook.trigger.webhookSecretHash, 'hash', 'the secret minted while drafting survives the publish')
})

test('triggerDraftDiff ignores server-held fields and names the kind of difference', () => {
  const live = { type: 'schedule', schedule: { type: 'daily', time: '09:00', anchor: '2026-01-01T00:00:00.000Z' }, webhookSecretHash: 'x' }
  assert.equal(triggerDraftDiff(live, { type: 'schedule', schedule: { time: '09:00', type: 'daily' } }), null)
  assert.equal(triggerDraftDiff(live, { type: 'schedule', schedule: { type: 'daily', time: '10:00' } }), 'config')
  assert.equal(triggerDraftDiff(live, { type: 'webhook' }), 'type')
  assert.equal(triggerDraftDiff({}, undefined), null, 'both default to manual')
})

test('triggerTypeLabel is plain English for every type', () => {
  for (const type of ['manual', 'schedule', 'poll', 'webhook', 'form', 'signal', 'slack', 'activity', undefined]) {
    const label = triggerTypeLabel(type)
    assert.ok(label && !/[{}_]/.test(label), `${String(type)} → ${label}`)
  }
})
