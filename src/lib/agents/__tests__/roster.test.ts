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
    avatarSeed: null,
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
  return { id, name, roleLabel: null, avatarSeed: null, createdAt: '2026-08-18T00:00:00.000Z' }
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
    a1: { runs: 10, completed: 8, failed: 2, blocked: 0, approximateRuns: 0 },
    a2: { runs: 5, completed: 5, failed: 0, blocked: 0, approximateRuns: 0 },
  }
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], kpis)
  assert.deepEqual(teammateCards[0].stats, { runs: 15, completed: 13, failed: 2, blocked: 0, approximateRuns: 0 })
})

test('falls back to the agent\'s own counter when no execution rows remain, and marks it approximate', () => {
  const agents = [agent({ id: 'a1', title: 'A', executionCount: 42 })]
  const { agentCards } = buildRoster(agents, [], {})
  assert.deepEqual(agentCards[0].stats, { runs: 0, completed: 0, failed: 0, blocked: 0, approximateRuns: 42 })
})

test('sumStats keeps a group\'s query-derived and approximate counts separate -- never summed into one mixed total', () => {
  const agents = [
    // a1 has real KPI rows: a finished, measured run history.
    agent({ id: 'a1', title: 'A', teammateId: 't1' }),
    // a2 has no execution rows left (pruned/history gap) -- only its own
    // optimistic counter survives, with no known completed/failed split.
    agent({ id: 'a2', title: 'B', teammateId: 't1', executionCount: 42 }),
  ]
  const kpis: Record<string, CardStats> = {
    a1: { runs: 10, completed: 8, failed: 2, blocked: 0, approximateRuns: 0 },
  }
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], kpis)
  // Measured runs/completed/failed come ONLY from a1; a2's counter-derived 42
  // lands in approximateRuns, never folded into the measured "runs" total.
  assert.deepEqual(teammateCards[0].stats, { runs: 10, completed: 8, failed: 2, blocked: 0, approximateRuns: 42 })
})

test('a group of purely approximate (counter-fallback) agents reports no success rate', () => {
  const agents = [
    agent({ id: 'a1', title: 'A', teammateId: 't1', executionCount: 10 }),
    agent({ id: 'a2', title: 'B', teammateId: 't1', executionCount: 20 }),
  ]
  const { teammateCards } = buildRoster(agents, [teammate('t1', 'Dana')], {})
  assert.deepEqual(teammateCards[0].stats, { runs: 0, completed: 0, failed: 0, blocked: 0, approximateRuns: 30 })
  // No measured finish exists for either agent -- the denominator must stay 0,
  // not divide across the approximate counter total.
  assert.equal(successRate(teammateCards[0].stats), null)
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
  assert.equal(successRate({ completed: 8, failed: 2 }), 80)
  // Three still in flight: the rate is about what finished, not what started.
  assert.equal(successRate({ completed: 2, failed: 0 }), 100)
  assert.equal(successRate({ completed: 0, failed: 0 }), null)
})

test('cards carry an instant derived role so a chip never waits on the network', () => {
  const agents = [agent({ id: 'a1', title: 'Monday thing', instructions: 'Summarize last week for the team' })]
  const { agentCards } = buildRoster(agents, [], {})
  assert.equal(agentCards[0].derivedRole, 'Summarizer')
})

test('a teammate takes a derived role only when its jobs agree', () => {
  const shared = [
    agent({ id: 'a1', title: 'A', teammateId: 't1', instructions: 'Summarize the call' }),
    agent({ id: 'a2', title: 'B', teammateId: 't1', instructions: 'Summarize the thread' }),
  ]
  assert.equal(buildRoster(shared, [teammate('t1', 'Dana')], {}).teammateCards[0].derivedRole, 'Summarizer')

  const mixed = [
    agent({ id: 'a1', title: 'A', teammateId: 't1', instructions: 'Summarize the call' }),
    agent({ id: 'a2', title: 'B', teammateId: 't1', instructions: 'Watch the pipeline' }),
  ]
  assert.equal(buildRoster(mixed, [teammate('t1', 'Dana')], {}).teammateCards[0].derivedRole, null)
})

test('search matches an agent by name and by what it does', () => {
  const agents = [
    agent({ id: 'a1', title: 'Renewals watcher', instructions: 'Watch renewals' }),
    agent({ id: 'a2', title: 'Deal briefer', instructions: 'Research each account' }),
  ]
  assert.deepEqual(buildRoster(agents, [], {}, 'renew').agentCards.map((c) => c.agent.id), ['a1'])
  // By derived role rather than by title.
  assert.deepEqual(buildRoster(agents, [], {}, 'researcher').agentCards.map((c) => c.agent.id), ['a2'])
  assert.equal(buildRoster(agents, [], {}, 'nothing here').agentCards.length, 0)
})

test('search finds a teammate by the job they run, not just their name', () => {
  const agents = [agent({ id: 'a1', title: 'Renewals watcher', teammateId: 't1' })]
  const roster = [teammate('t1', 'Dana')]
  assert.equal(buildRoster(agents, roster, {}, 'dana').teammateCards.length, 1)
  assert.equal(buildRoster(agents, roster, {}, 'renewals').teammateCards.length, 1)
  assert.equal(buildRoster(agents, roster, {}, 'zzz').teammateCards.length, 0)
})

test('search is case-insensitive and ignores surrounding whitespace', () => {
  const agents = [agent({ id: 'a1', title: 'Renewals watcher' })]
  assert.equal(buildRoster(agents, [], {}, '  RENEWALS  ').agentCards.length, 1)
})

test('blocked runs are finished-but-not-successful, so they drag the rate down', () => {
  // The case this exists for: an agent that ran every day and delivered
  // nothing, because its Gmail integration never resolved. Counting those as
  // successes read as 100% while the workspace shipped nothing.
  assert.equal(successRate({ completed: 0, failed: 0, blocked: 5 }), 0)
  assert.equal(successRate({ completed: 5, failed: 0, blocked: 5 }), 50)
  assert.equal(successRate({ completed: 8, failed: 1, blocked: 1 }), 80)
  // Absent (older callers / pre-blocked stats) still behaves as before.
  assert.equal(successRate({ completed: 8, failed: 2 }), 80)
})
