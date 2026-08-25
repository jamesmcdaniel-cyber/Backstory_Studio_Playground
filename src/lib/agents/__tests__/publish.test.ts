import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentDefinition,
  applyPublishedDefinition,
  hasUnpublishedChanges,
  pinnedConnectorKeys,
  publishedDefinition,
  type PublishableAgent,
} from '@/lib/agents/publish'

const draft = (over: Partial<PublishableAgent> = {}): PublishableAgent => ({
  description: 'Renewal watcher',
  objective: 'Watch renewals and brief the rep.',
  goal: null,
  context: {},
  schedule: { type: 'cron' },
  metadata: { integrations: ['slack'] },
  ...over,
})

/**
 * Every agent that exists today is unpublished, and the whole point of adding
 * this is that nothing about their runs changes until someone chooses to
 * publish. That is the property most worth pinning.
 */

test('an unpublished agent runs exactly as it always has', () => {
  const agent = draft()
  assert.equal(publishedDefinition(agent), null)
  assert.equal(hasUnpublishedChanges(agent), false)
  assert.equal(pinnedConnectorKeys(agent), null)

  const resolved = applyPublishedDefinition(agent)
  assert.equal(resolved.publishedPinned, false)
  assert.equal(resolved.objective, 'Watch renewals and brief the rep.')
})

test('a published agent runs the published words, not the edited ones', () => {
  const agent = draft({
    objective: 'EDITED after publishing',
    publishedConfig: { ...agentDefinition(draft(), ['slack']) },
  })
  const resolved = applyPublishedDefinition(agent)
  assert.equal(resolved.objective, 'Watch renewals and brief the rep.')
  assert.equal(resolved.publishedPinned, true)
})

test('publishing pins the tools as well as the words', () => {
  // Adding a write-capable integration to a published agent would otherwise
  // change what it can do to the world with nothing republished.
  const agent = draft({ publishedConfig: { ...agentDefinition(draft(), ['slack']) } })
  assert.deepEqual(pinnedConnectorKeys(agent), ['slack'])
})

test('publishing pins what the agent does, never who it is or whether it may run', () => {
  // Deactivating a published agent has to stop it.
  const agent = { ...draft({ publishedConfig: { ...agentDefinition(draft()) } }), id: 'a1', status: 'PAUSED', userId: 'u1' }
  const resolved = applyPublishedDefinition(agent)
  assert.equal(resolved.status, 'PAUSED')
  assert.equal(resolved.userId, 'u1')
  assert.equal(resolved.id, 'a1')
})

test('a half-written snapshot falls back to live rather than running half of one', () => {
  for (const broken of [{ objective: 'only this' }, { description: 'only this' }, {}, 'nonsense', null, []]) {
    assert.equal(publishedDefinition(draft({ publishedConfig: broken })), null, JSON.stringify(broken))
  }
})

test('the editor can tell whether the draft has moved', () => {
  const published = { ...agentDefinition(draft(), ['slack']) }

  assert.equal(hasUnpublishedChanges(draft({ publishedConfig: published }), ['slack']), false)
  assert.equal(
    hasUnpublishedChanges(draft({ objective: 'Changed', publishedConfig: published }), ['slack']),
    true,
  )
  // Binding a new tool is an unpublished change too — it is what the agent can do.
  assert.equal(hasUnpublishedChanges(draft({ publishedConfig: published }), ['slack', 'salesforce']), true)
})

test('connector order is not a change', () => {
  // The set is what matters; the order rows came back in is not something a
  // user did, and reporting it as an unpublished change would be noise forever.
  const published = { ...agentDefinition(draft(), ['salesforce', 'slack']) }
  assert.equal(hasUnpublishedChanges(draft({ publishedConfig: published }), ['slack', 'salesforce']), false)
})

test('key order inside context or metadata is not a change either', () => {
  const published = { ...agentDefinition(draft({ context: { a: 1, b: 2 } })) }
  assert.equal(hasUnpublishedChanges(draft({ context: { b: 2, a: 1 }, publishedConfig: published })), false)
})
