import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advancedParamSummary } from '@/lib/flows/advanced-params'
import type { FlowNode } from '@/lib/flows/graph'

const http = (data: Record<string, unknown>) =>
  ({ id: 'n1', type: 'http', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://x.test', ...data } }) as unknown as FlowNode

/**
 * A step's advanced parameters change how it RUNS — whether a failure stops the
 * flow, how many times it retries, whether a 500 counts as an error. The panel
 * said only "Showing 2 of 8", so the two settings that were actually in force
 * were invisible until you expanded the section, and stayed invisible to anyone
 * reading the flow afterwards.
 */

test('a step with nothing set summarizes to nothing', () => {
  assert.deepEqual(advancedParamSummary(http({})), [])
})

test('each set parameter reads as plain English', () => {
  const summary = advancedParamSummary(http({ onError: 'continue', retries: 3, timeoutMs: 30_000 }))
  assert.deepEqual(summary.map((entry) => entry.text), [
    'Continues on error',
    '3 retries',
    'Timeout 30s',
  ])
})

test('singular and zero counts read correctly', () => {
  assert.equal(advancedParamSummary(http({ retries: 1 }))[0].text, '1 retry')
  assert.equal(advancedParamSummary(http({ retries: 0 }))[0].text, 'No retries')
})

test('a parameter set to its default still shows — it was chosen', () => {
  // `onError: 'stop'` is the default behaviour, but someone set it explicitly.
  // Hiding it would make the panel disagree with the stored graph.
  assert.deepEqual(advancedParamSummary(http({ onError: 'stop' })).map((e) => e.text), ['Stops the flow on error'])
})

test('booleans read as behaviour, not as true/false', () => {
  assert.equal(advancedParamSummary(http({ failOnHttpError: false }))[0].text, 'Returns 4xx/5xx responses')
  assert.equal(advancedParamSummary(http({ alwaysOutputData: true }))[0].text, 'Always outputs data')
})

test('summary order follows the manifest, not object key order', () => {
  const summary = advancedParamSummary(http({ timeoutMs: 5_000, responseType: 'file', onError: 'continue' }))
  assert.deepEqual(summary.map((entry) => entry.key), ['responseType', 'onError', 'timeoutMs'])
})

test('a parameter the node type does not support is ignored', () => {
  // `concurrency` belongs to For-each, not to an HTTP step.
  assert.deepEqual(advancedParamSummary(http({ concurrency: 5 })), [])
})
