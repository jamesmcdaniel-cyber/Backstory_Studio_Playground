import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentActions, agentPermissions, chatBlockedReason } from '../viewer-gates'

const member = agentPermissions((permission) => ['agent.read', 'agent.write', 'agent.run'].includes(permission))
const viewer = agentPermissions((permission) => permission === 'agent.read')
const admin = agentPermissions(() => true)

test('a member configures and runs their workspace’s agents', () => {
  assert.deepEqual(agentActions({ agentType: 'custom' }, member), { openArtifactId: null, configure: true, run: true, chat: true })
})

test('a VIEWER member is offered nothing the agent routes would refuse', () => {
  const actions = agentActions({ agentType: 'custom' }, viewer)
  assert.equal(actions.configure, false, 'PUT /api/agents needs agent.write')
  assert.equal(actions.run, false, 'execute and reply need agent.run')
  assert.equal(actions.chat, false, 'chat POST needs agent.run')
  assert.match(chatBlockedReason({ agentType: 'custom' }, viewer) ?? '', /admin/i)
})

test('an external agent’s settings need api.manage, not just agent.write', () => {
  assert.equal(agentActions({ agentType: 'external' }, member).configure, false)
  assert.equal(agentActions({ agentType: 'external' }, admin).configure, true)
})

/**
 * Listed so its run links resolve; operated only from its artifact — chat,
 * run, PUT and DELETE all answer "Agent not found" for it.
 */
test('a template copy’s copilot opens its artifact and offers nothing of its own', () => {
  const actions = agentActions({ agentType: 'custom', templateCopyArtifactId: 'art-1' }, admin)
  assert.deepEqual(actions, { openArtifactId: 'art-1', configure: false, run: false, chat: false })
  assert.match(chatBlockedReason({ agentType: 'custom', templateCopyArtifactId: 'art-1' }, admin) ?? '', /artifact/i)
})

test('the composer is open for a member on an ordinary agent, and with nothing selected', () => {
  assert.equal(chatBlockedReason({ agentType: 'custom' }, member), null)
  assert.equal(chatBlockedReason(null, viewer), null)
})
