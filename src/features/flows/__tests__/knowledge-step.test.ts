import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveKnowledgeStepParams } from '../run-action-step'

test('with no scope configured the step stays workspace-wide, as saved flows expect', () => {
  const params = resolveKnowledgeStepParams({ query: 'renewal criteria' })
  assert.equal(params.agentId, '')
  assert.equal(params.collectionId, undefined)
})

test('a configured agent scope is passed through', () => {
  const params = resolveKnowledgeStepParams({ query: 'x', scope: { agentId: 'agent_1' } })
  assert.equal(params.agentId, 'agent_1')
})

test('a configured collection scope is passed through', () => {
  const params = resolveKnowledgeStepParams({ query: 'x', scope: { collectionId: 'col_1' } })
  assert.equal(params.collectionId, 'col_1')
})

test('the relevance floor applies by default and is overridable', () => {
  assert.equal(resolveKnowledgeStepParams({ query: 'x' }).minScore, 0.35)
  assert.equal(resolveKnowledgeStepParams({ query: 'x', minScore: 0 }).minScore, 0)
})

test('topK clamps to the documented 1-20 range', () => {
  assert.equal(resolveKnowledgeStepParams({ query: 'x', topK: 999 }).k, 20)
  assert.equal(resolveKnowledgeStepParams({ query: 'x', topK: 0 }).k, 1)
})

test('a malformed scope object degrades to workspace-wide rather than throwing', () => {
  assert.equal(resolveKnowledgeStepParams({ query: 'x', scope: 'nonsense' }).agentId, '')
  assert.equal(resolveKnowledgeStepParams({ query: 'x', scope: ['a'] }).agentId, '')
})
