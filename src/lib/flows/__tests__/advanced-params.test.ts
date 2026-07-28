import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamKeys, advancedParamsSetCount } from '../advanced-params'
import type { FlowNode } from '../graph'

test('each node type declares its advanced keys', () => {
  assert.deepEqual(advancedParamKeys('agent'), ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData'])
  assert.deepEqual(advancedParamKeys('tool'), ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData'])
  assert.deepEqual(advancedParamKeys('http'), [
    'responseType', 'failOnHttpError', 'onError', 'retries', 'retryDelayMs', 'timeoutMs', 'maxRedirects', 'alwaysOutputData',
  ])
  assert.deepEqual(advancedParamKeys('loop'), ['concurrency', 'batchSize'])
  assert.deepEqual(advancedParamKeys('trigger'), [])
})

test('the reliability settings reach every node that can retry', () => {
  // "Wait between tries" and "Always output data" are node-level settings in
  // n8n; a retryable node here must offer both or they are unreachable.
  for (const type of ['agent', 'ai', 'tool', 'http', 'subflow'] as const) {
    const keys = advancedParamKeys(type)
    assert.ok(keys.includes('retries') && keys.includes('retryDelayMs'), `${type} is missing the retry wait`)
    assert.ok(keys.includes('alwaysOutputData'), `${type} is missing always-output-data`)
  }
  assert.ok(advancedParamKeys('subflow').includes('waitForCompletion'))
})

test('advancedParamsSetCount counts only explicitly-set params', () => {
  const bare: FlowNode = { id: 'n1', type: 'http', data: { method: 'POST', url: 'https://x.test' } }
  assert.equal(advancedParamsSetCount(bare), 0)
  const tuned: FlowNode = {
    id: 'n2',
    type: 'http',
    data: { method: 'GET', url: 'https://x.test', retries: 2, failOnHttpError: false },
  }
  assert.equal(advancedParamsSetCount(tuned), 2)
})
