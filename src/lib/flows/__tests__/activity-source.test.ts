import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activitySourceDisplayName, activitySourceForToolKey } from '../activity-source'
import { subtitleFor, type PresentationContext } from '../node-presentation'
import type { FlowNode } from '../graph'

const ctx: PresentationContext = { agentName: () => '', toolCatalog: [] }

function triggerNode(trigger: Record<string, unknown>): FlowNode {
  return { id: 'trigger', type: 'trigger', data: { trigger } } as unknown as FlowNode
}

test('activitySourceForToolKey mirrors normalize.ts: slack/salesforce are literal, everything else is nango:<provider>', () => {
  assert.equal(activitySourceForToolKey('Slack'), 'slack')
  assert.equal(activitySourceForToolKey('Salesforce'), 'salesforce')
  assert.equal(activitySourceForToolKey('github'), 'nango:github')
  assert.equal(activitySourceForToolKey('Gmail'), 'nango:gmail')
})

test('activitySourceDisplayName humanizes known brands and unknown nango providers, never the raw scheme', () => {
  assert.equal(activitySourceDisplayName('slack'), 'Slack')
  assert.equal(activitySourceDisplayName('salesforce'), 'Salesforce')
  assert.equal(activitySourceDisplayName('nango:github'), 'GitHub')
  assert.equal(activitySourceDisplayName('nango:acme-crm'), 'Acme Crm')
  assert.equal(activitySourceDisplayName(''), 'a connected app')
  assert.equal(activitySourceDisplayName(undefined), 'a connected app')
  for (const value of ['slack', 'salesforce', 'nango:github', 'nango:acme-crm']) {
    assert.ok(!activitySourceDisplayName(value).includes('nango:'), `display name for "${value}" leaked the raw scheme`)
  }
})

test('the activity trigger subtitle never renders a raw nango: source string', () => {
  const subtitle = subtitleFor(triggerNode({ type: 'activity', source: 'nango:github', kinds: ['pr.opened', 'pr.merged'] }), ctx)
  assert.equal(subtitle, 'Watches GitHub for 2 event types')
  assert.ok(!subtitle?.includes('nango:'))
})

test('the activity trigger subtitle humanizes a bare known source too', () => {
  const subtitle = subtitleFor(triggerNode({ type: 'activity', source: 'salesforce', kinds: ['record.updated'] }), ctx)
  assert.equal(subtitle, 'Watches Salesforce for 1 event type')
})

test('an unconfigured activity trigger still asks to pick an app, no source to humanize yet', () => {
  const subtitle = subtitleFor(triggerNode({ type: 'activity' }), ctx)
  assert.equal(subtitle, 'Pick an app and at least one event type to watch')
})
