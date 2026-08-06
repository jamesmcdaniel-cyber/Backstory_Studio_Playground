import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTokenSegments, serializeTokenSegments, friendlyTokenLabel, humanizeTokens, stepLabelsOf } from '../token-text'
import { emptyGraph } from '../graph'
import { insertNodeAfter } from '../mutate'

const ctx = { stepLabels: { n1: 'Score each', n2: 'Pull accounts' } }

test('parseTokenSegments splits text and tokens, trims token padding', () => {
  assert.deepEqual(parseTokenSegments('Scorecards: {{step.n1.output}} done'), [
    { kind: 'text', value: 'Scorecards: ' },
    { kind: 'token', path: 'step.n1.output' },
    { kind: 'text', value: ' done' },
  ])
  assert.deepEqual(parseTokenSegments('{{ trigger.input }}'), [{ kind: 'token', path: 'trigger.input' }])
  assert.deepEqual(parseTokenSegments(''), [])
  assert.deepEqual(parseTokenSegments('no tokens'), [{ kind: 'text', value: 'no tokens' }])
})

test('serialize round-trips canonical strings', () => {
  const v = 'a {{step.n1.output.score}} b {{item}} c'
  assert.equal(serializeTokenSegments(parseTokenSegments(v)), v)
})

test('friendlyTokenLabel maps the grammar to plain english', () => {
  assert.equal(friendlyTokenLabel('trigger.input', ctx), 'Run input')
  assert.equal(friendlyTokenLabel('trigger.input.accountId', ctx), 'Run input › accountId')
  assert.equal(friendlyTokenLabel('step.n1.output', ctx), 'Score each')
  assert.equal(friendlyTokenLabel('step.n1.output.score', ctx), 'Score each › score')
  assert.equal(friendlyTokenLabel('step.n9.output', ctx), 'Step n9')
  assert.equal(friendlyTokenLabel('item', ctx), 'Current item')
  assert.equal(friendlyTokenLabel('item.name', ctx), 'Current item › name')
  assert.equal(friendlyTokenLabel('loop.index', ctx), 'Item number')
  assert.equal(friendlyTokenLabel('step.n1.output.0', ctx), 'Score each › item 1')
  assert.equal(friendlyTokenLabel('totally.unknown', ctx), 'totally.unknown')
})

test('humanizeTokens strips every brace from mixed text', () => {
  const out = humanizeTokens('Scorecards: {{step.n1.output}} and {{trigger.input.accountId}}', ctx)
  assert.equal(out, 'Scorecards: Score each and Run input › accountId')
  assert.equal(out.includes('{{'), false)
})

test('stepLabelsOf resolves agent titles and typed fallbacks', () => {
  let g = emptyGraph()
  const a = insertNodeAfter(g, 'trigger', 'agent')
  g = a.graph
  const h = insertNodeAfter(g, a.nodeId, 'http')
  g = h.graph
  const withAgent = { ...g, nodes: g.nodes.map((n) => (n.id === a.nodeId ? { ...n, data: { ...n.data, agentId: 'ag1' } } : n)) }
  const labels = stepLabelsOf(withAgent as typeof g, [{ id: 'ag1', title: 'Researcher' }])
  assert.equal(labels[a.nodeId], 'Researcher')
  assert.equal(labels[h.nodeId], 'Http')
  assert.equal('trigger' in labels, false)
})

test('friendlyTokenLabel humanizes variable tokens', () => {
  assert.equal(friendlyTokenLabel('var.deal_count', ctx), 'Variable › deal_count')
  assert.equal(friendlyTokenLabel('var.deal.stage', ctx), 'Variable › deal › stage')
})

test('friendlyTokenLabel maps now / run / flow context tokens', () => {
  assert.equal(friendlyTokenLabel('now', ctx), 'Current time')
  assert.equal(friendlyTokenLabel('now.date', ctx), "Today's date")
  assert.equal(friendlyTokenLabel('now.time', ctx), 'Current time of day')
  assert.equal(friendlyTokenLabel('now.unix', ctx), 'Timestamp')
  assert.equal(friendlyTokenLabel('run.id', ctx), 'This run › id')
  assert.equal(friendlyTokenLabel('run.startedAt', ctx), 'This run › started')
  assert.equal(friendlyTokenLabel('run.trigger', ctx), 'This run › trigger')
  assert.equal(friendlyTokenLabel('run.url', ctx), 'This run › link')
  assert.equal(friendlyTokenLabel('flow.id', ctx), 'This flow › id')
  assert.equal(friendlyTokenLabel('flow.name', ctx), 'This flow › name')
})

test('friendlyTokenLabel renders {{input}} as Incoming data', () => {
  const ctx = { stepLabels: {} }
  assert.equal(friendlyTokenLabel('input', ctx), 'Incoming data')
  assert.equal(friendlyTokenLabel('input.userId', ctx), 'Incoming data › userId')
})
