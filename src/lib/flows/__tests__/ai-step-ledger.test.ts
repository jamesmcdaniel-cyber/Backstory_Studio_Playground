import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFlowAiLedgerContext } from '../ai-step-ledger'

/**
 * The flow 'ai' step used to hand runner.next() a ledger context labeled
 * surface: 'agent_turn' (the agent runtime's own label) and no flowRunStepId
 * at all — so a standalone ai-step call was indistinguishable from an agent
 * turn in cost breakdowns, and unattributable to the specific step that made
 * it. This pins the corrected shape.
 */
test('carries surface "flow_ai" and the step row id, not "agent_turn"', () => {
  const context = buildFlowAiLedgerContext({
    organizationId: 'org-1',
    userId: 'user-1',
    flowRunId: 'run-1',
    flowRunStepId: 'step-1',
  })
  assert.equal(context.surface, 'flow_ai')
  assert.notEqual((context as { surface: string }).surface, 'agent_turn')
  assert.equal(context.flowRunStepId, 'step-1')
  assert.equal(context.flowRunId, 'run-1')
  assert.equal(context.organizationId, 'org-1')
})

test('defaults userId to null when the run has no owner (system dispatch)', () => {
  const context = buildFlowAiLedgerContext({
    organizationId: 'org-1',
    flowRunId: 'run-1',
    flowRunStepId: 'step-1',
  })
  assert.equal(context.userId, null)
})
