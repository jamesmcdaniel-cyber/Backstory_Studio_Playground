import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph } from '../validate'

// Activity-event substrate (Task 5): the two event-trigger types' own rules,
// kept in their own small file — validate.test.ts sits just under a
// tsx+node22 file-size cliff (~45KB) where module load spins forever in a
// regex split; validate-rules.test.ts is the sibling file for the same reason.

function graphWithTrigger(trigger: unknown): FlowGraph {
  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger } },
      { id: 'a', type: 'agent', data: { agentId: 'agent-1', input: 'Go' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'a' }],
  }
}

test('an armed activity trigger needs a source and at least one event kind', () => {
  const missingBoth = validateFlowGraph(graphWithTrigger({ type: 'activity' }), { agents: [{ id: 'agent-1' }] })
  assert.ok(missingBoth.errors.some((issue) => issue.code === 'MISSING_ACTIVITY_CONFIG' && /needs an app and at least one event type/.test(issue.message)))

  const missingKinds = validateFlowGraph(graphWithTrigger({ type: 'activity', source: 'salesforce', kinds: [] }), { agents: [{ id: 'agent-1' }] })
  assert.ok(missingKinds.errors.some((issue) => issue.code === 'MISSING_ACTIVITY_CONFIG'))

  const missingSource = validateFlowGraph(graphWithTrigger({ type: 'activity', kinds: ['opportunity.updated'] }), { agents: [{ id: 'agent-1' }] })
  assert.ok(missingSource.errors.some((issue) => issue.code === 'MISSING_ACTIVITY_CONFIG'))

  const valid = validateFlowGraph(graphWithTrigger({ type: 'activity', source: 'salesforce', kinds: ['opportunity.updated'] }), { agents: [{ id: 'agent-1' }] })
  assert.ok(!valid.errors.some((issue) => issue.code === 'MISSING_ACTIVITY_CONFIG'))
})

test('an armed slack trigger needs a connected Slack workspace', () => {
  const graph = graphWithTrigger({ type: 'slack', channelId: 'C0123' })

  // Draft/manual-run validation omits the flag entirely — never blocked.
  const draft = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(!draft.errors.some((issue) => issue.code === 'MISSING_SLACK_WORKSPACE'))

  const notConnected = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }], slackWorkspaceConnected: false })
  assert.ok(notConnected.errors.some((issue) => issue.code === 'MISSING_SLACK_WORKSPACE' && /connected Slack workspace/.test(issue.message)))

  const connected = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }], slackWorkspaceConnected: true })
  assert.ok(!connected.errors.some((issue) => issue.code === 'MISSING_SLACK_WORKSPACE'))
})

test('event triggers (activity, slack) are blocked from arming on a free-tier org', () => {
  const validActivity = { type: 'activity', source: 'salesforce', kinds: ['opportunity.updated'] }
  const validSlack = { type: 'slack', channelId: 'C0123' }

  for (const trigger of [validActivity, validSlack]) {
    const blocked = validateFlowGraph(graphWithTrigger(trigger), {
      agents: [{ id: 'agent-1' }],
      slackWorkspaceConnected: true,
      eventTriggerEntitled: false,
    })
    assert.ok(
      blocked.errors.some((issue) => issue.code === 'EVENT_TRIGGER_NOT_ENTITLED' && issue.message === 'Event triggers are available on paid workspaces.'),
      `expected ${trigger.type} to be blocked when not entitled`,
    )

    const allowed = validateFlowGraph(graphWithTrigger(trigger), {
      agents: [{ id: 'agent-1' }],
      slackWorkspaceConnected: true,
      eventTriggerEntitled: true,
    })
    assert.ok(!allowed.errors.some((issue) => issue.code === 'EVENT_TRIGGER_NOT_ENTITLED'))

    // Draft/manual-run validation (flag omitted) never blocks on entitlement.
    const draft = validateFlowGraph(graphWithTrigger(trigger), { agents: [{ id: 'agent-1' }], slackWorkspaceConnected: true })
    assert.ok(!draft.errors.some((issue) => issue.code === 'EVENT_TRIGGER_NOT_ENTITLED'))
  }
})
