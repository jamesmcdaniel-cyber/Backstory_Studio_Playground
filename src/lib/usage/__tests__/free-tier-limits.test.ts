import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE_TIER_LIMITS,
  countableIntegrations,
  isUnlimitedActor,
  limitMessage,
  startOfUtcDay,
} from '../free-tier-limits'

test('the ceilings are the agreed numbers', () => {
  assert.equal(FREE_TIER_LIMITS.agentRunsPerDay, 5)
  assert.equal(FREE_TIER_LIMITS.flowRunsPerDay, 5)
  assert.equal(FREE_TIER_LIMITS.integrations, 3)
})

test('super admins are exempt; ordinary members are not', () => {
  assert.equal(isUnlimitedActor({ canReview: true, email: 'reviewer@people.ai' }), true)
  // The platform owner is exempt by identity even without the review permission
  // resolved (e.g. acting inside a customer workspace).
  assert.equal(isUnlimitedActor({ canReview: false, email: 'james.mcdaniel@backstory.ai' }), true)
  assert.equal(isUnlimitedActor({ canReview: false, email: 'JAMES.MCDANIEL@PEOPLE.AI' }), true)

  assert.equal(isUnlimitedActor({ canReview: false, email: 'member@customer.com' }), false)
  assert.equal(isUnlimitedActor({ canReview: false, email: null }), false)
  assert.equal(isUnlimitedActor({ canReview: false }), false)
})

test('MCP servers do not count toward the integration ceiling', () => {
  const providers = [
    { plane: 'nango' as const },
    { plane: 'nango' as const },
    { plane: 'mcp' as const },
    { plane: 'mcp' as const },
    { plane: 'builtin' as const },
  ]
  // Two Nango accounts + one workspace-owned builtin credential = 3.
  assert.equal(countableIntegrations(providers), 3)
  assert.equal(countableIntegrations([]), 0)
  assert.equal(countableIntegrations([{ plane: 'mcp' as const }]), 0)
})

test('a workspace of only MCP servers is never blocked', () => {
  const mcpOnly = Array.from({ length: 20 }, () => ({ plane: 'mcp' as const }))
  assert.ok(countableIntegrations(mcpOnly) < FREE_TIER_LIMITS.integrations)
})

test('the daily window starts at midnight UTC', () => {
  const start = startOfUtcDay(new Date('2026-08-09T17:42:31.500Z'))
  assert.equal(start.toISOString(), '2026-08-09T00:00:00.000Z')
  // A time already at midnight is its own window start.
  assert.equal(startOfUtcDay(new Date('2026-08-09T00:00:00.000Z')).toISOString(), '2026-08-09T00:00:00.000Z')
})

test('refusal messages say what to do next, without quota jargon', () => {
  const agent = limitMessage('agent', 5)
  assert.match(agent, /all 5 agent runs for today/)
  assert.match(agent, /midnight UTC/)
  assert.match(limitMessage('flow', 5), /flow runs/)
  assert.match(limitMessage('integration', 3), /limit of 3 connected integrations/)
  // No raw enum or code leaks into copy a person reads.
  for (const message of [agent, limitMessage('integration', 3)]) {
    assert.doesNotMatch(message, /DAILY_LIMIT_REACHED|free_tier|quota/i)
  }
})
