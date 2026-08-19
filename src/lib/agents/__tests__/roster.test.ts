import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRoster, presenceFor, successRate, type CardStats } from '../roster'
import type { Agent, Teammate } from '@/lib/types'

function agent(overrides: Partial<Agent> & { id: string; title: string }): Agent {
  return {
    description: '',
    instructions: 'do the thing',
    model: 'claude',
    integrations: [],
    skills: [],
    icon: '',
    roleLabel: null,
    teammateId: null,
    folder: null,
    visibility: 'shared',
    status: 'active',
    priority: 'medium',
    schedule: { type: 'manual', isActive: false },
    ...overrides,
  }
}

function teammate(id: string, name: string): Teammate {
  return { id, name, roleLabel: null, createdAt: '2026-08-18T00:00:00.000Z' }
}

test('groups agents under their teammate and leaves the rest solo', () => {
  const agents = [
    agent({ id: 'a1', title: 'Renewals', teammateId: 't1' }),
    agent({ id: 'a2', title: 'Briefings', teammateId: 't1' }),
    agent({ id: 'a3', title: 'Standalone' }),
  ]
  const { teammateCards, agentCards } = buildRoster(agents, [teammate('t1', 'Dana')], {})

  assert.equal(teammateCards.length, 1)
  assert.deepEqual(teammateCards[0].agents.map((a) => a.id), ['a2', 'a1']) // alphabetical by title
  assert.equal(agentCards.length, 1)
  assert.equal(agentCards[0].agent.id, 'a3')
})

test('a teammate with exactly one job exposes it as soleAgent', () => {
  const agents = [agent({ id: 'a1', title: 'Renewals', teammateId: 't1' })]
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], {})
  assert.equal(teammateCards[0].soleAgent?.id, 'a1')
})

test('a teammate with several jobs has no soleAgent', () => {
  const agents = [
    agent({ id: 'a1', title: 'Renewals', teammateId: 't1' }),
    agent({ id: 'a2', title: 'Briefings', teammateId: 't1' }),
  ]
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], {})
  assert.equal(teammateCards[0].soleAgent, null)
})

test('a teammate whose agents are all invisible is not shown as an empty stranger', () => {
  const { teammateCards } = buildRoster([], [teammate('t1', 'Ghost')], {})
  assert.deepEqual(teammateCards, [])
})

test('teammate stats add up across the whole roster', () => {
  const agents = [
    agent({ id: 'a1', title: 'A', teammateId: 't1' }),
    agent({ id: 'a2', title: 'B', teammateId: 't1' }),
  ]
  const kpis: Record<string, CardStats> = {
    a1: { runs: 10, completed: 8, failed: 2 },
    a2: { runs: 5, completed: 5, failed: 0 },
  }
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], kpis)
  assert.deepEqual(teammateCards[0].stats, { runs: 15, completed: 13, failed: 2 })
})

test('falls back to the agent\'s own counter when no execution rows remain', () => {
  const agents = [agent({ id: 'a1', title: 'A', executionCount: 42 })]
  const { agentCards } = buildRoster(agents, [], {})
  assert.deepEqual(agentCards[0].stats, { runs: 42, completed: 0, failed: 0 })
})

test('presence reflects setup and schedule', () => {
  assert.equal(presenceFor(agent({ id: 'a', title: 'A', instructions: '' })), 'idle')
  assert.equal(presenceFor(agent({ id: 'a', title: 'A', status: 'paused' })), 'idle')
  assert.equal(presenceFor(agent({ id: 'a', title: 'A' })), 'ready')
  assert.equal(presenceFor(agent({ id: 'a', title: 'A', schedule: { type: 'daily', isActive: true } })), 'working')
})

test('one scheduled job makes the whole avatar read as working', () => {
  const agents = [
    agent({ id: 'a1', title: 'A', teammateId: 't1' }),
    agent({ id: 'a2', title: 'B', teammateId: 't1', schedule: { type: 'daily', isActive: true } }),
  ]
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], {})
  assert.equal(teammateCards[0].presence, 'working')
})

test('success rate counts only finished runs, and is null before any finish', () => {
  assert.equal(successRate({ runs: 10, completed: 8, failed: 2 }), 80)
  // Three still in flight: the rate is about what finished, not what started.
  assert.equal(successRate({ runs: 5, completed: 2, failed: 0 }), 100)
  assert.equal(successRate({ runs: 3, completed: 0, failed: 0 }), null)
})
