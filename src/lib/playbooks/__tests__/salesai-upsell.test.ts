import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema } from '@/lib/flows/graph'
import { buildUpsellGraph, PLAYBOOK_AGENTS } from '../salesai-upsell'

const ids = { puller: 'a1', scorer: 'a2', composer: 'a3', publisher: 'a4' }

test('buildUpsellGraph produces a schema-valid, fully wired graph', () => {
  const graph = flowGraphSchema.parse(buildUpsellGraph(ids))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const pull = byId.get('pull')
  const score = byId.get('score')
  const publish = byId.get('publish')
  assert.equal(pull?.type === 'agent' && pull.data.agentId, 'a1')
  assert.equal(score?.type === 'agent' && score.data.agentId, 'a2')
  assert.equal(publish?.type === 'agent' && publish.data.agentId, 'a4')
  // loop contains the scorer and reads the puller's output
  const loop = byId.get('score_each')
  assert.ok(loop?.type === 'loop' && loop.data.body.includes('score') && loop.data.over.includes('step.pull.output'))
  // chain: trigger -> pull -> loop -> parallel outputs -> publish
  const chain = graph.edges.map((e) => `${e.source}>${e.target}`)
  assert.deepEqual(chain, ['trigger>pull', 'pull>score_each', 'score_each>outputs', 'outputs>publish'])
})

test('all four BRD outputs are built in parallel by the composer', () => {
  const graph = buildUpsellGraph(ids)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const outputs = byId.get('outputs')
  assert.ok(outputs?.type === 'parallel')
  const branchIds = outputs.type === 'parallel' ? outputs.data.branches.flat() : []
  assert.deepEqual(branchIds, ['matrix', 'stakeholders', 'actions', 'digest'])
  for (const id of branchIds) {
    const node = byId.get(id)
    assert.ok(node?.type === 'agent' && node.data.agentId === ids.composer, `${id} runs the composer`)
    assert.ok(node?.type === 'agent' && node.data.input?.includes('{{step.score_each.output}}'), `${id} reads scorecards`)
  }
  // publisher assembles the merged parallel output
  const publish = byId.get('publish')
  assert.ok(publish?.type === 'agent' && publish.data.input?.includes('{{step.outputs.output}}'))
})

test('scorer contract covers all four AI-processing dimensions', () => {
  const text = PLAYBOOK_AGENTS.scorer.instructions
  for (const key of ['subscores', 'competitiveRisk', 'useCaseAlignment', 'salesMotion', 'dataGaps']) {
    assert.ok(text.includes(key), `scorer contract includes ${key}`)
  }
})

test('playbook agents carry the connector keys their tools need', () => {
  assert.ok(PLAYBOOK_AGENTS.puller.integrations.includes('nango:salesforce')) // CRM
  assert.ok(PLAYBOOK_AGENTS.puller.integrations.includes('HTTP API')) // connected usage/query API
  assert.ok(PLAYBOOK_AGENTS.scorer.integrations.includes('nango:salesforce'))
  assert.ok(PLAYBOOK_AGENTS.scorer.integrations.includes('HTTP API'))
  assert.ok(PLAYBOOK_AGENTS.publisher.integrations.includes('nango:slack'))
  // every agent can hit external REST APIs via the built-in HTTP tool (Query API)
  for (const def of Object.values(PLAYBOOK_AGENTS)) {
    assert.ok(def.integrations.includes('HTTP API'))
  }
})
