import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowToolOutput, inBandErrorWarning } from '../tool-output'

test('flowToolOutput preserves structuredContent as direct workflow output', () => {
  assert.deepEqual(flowToolOutput({
    structuredContent: { id: 'acct_1', score: 92 },
    content: [{ type: 'text', text: 'Account acct_1' }],
  }), { id: 'acct_1', score: 92 })
})

test('flowToolOutput parses JSON text content and top-level JSON strings', () => {
  assert.deepEqual(flowToolOutput({ content: [{ type: 'text', text: '{"ok":true,"items":[1,2]}' }] }), {
    ok: true,
    items: [1, 2],
  })
  assert.deepEqual(flowToolOutput('{"ok":true}'), { ok: true })
})

test('flowToolOutput returns plain text content and fails MCP error results', () => {
  assert.equal(flowToolOutput({ content: [{ type: 'text', text: 'sent to Slack' }] }), 'sent to Slack')
  assert.throws(() => flowToolOutput({ isError: true, content: [{ type: 'text', text: 'Slack rejected the message' }] }), /Slack rejected/)
})

test('inBandErrorWarning flags success payloads that carry an error field', () => {
  assert.match(inBandErrorWarning({ error: 'no such channel' }) ?? '', /no such channel/)
  assert.match(inBandErrorWarning({ ok: false, error: 'rate limited' }) ?? '', /rate limited/)
  assert.match(inBandErrorWarning({ error: { code: 42 }, status: 'failed' }) ?? '', /"code":42/)
})

test('inBandErrorWarning leaves real data and empty errors alone', () => {
  assert.equal(inBandErrorWarning({ error: null }), undefined)
  assert.equal(inBandErrorWarning({ error: '' }), undefined)
  assert.equal(inBandErrorWarning({ ok: true, data: [] }), undefined)
  assert.equal(inBandErrorWarning({ error: 'soft', results: [1, 2] }), undefined)
  assert.equal(inBandErrorWarning('plain text'), undefined)
  assert.equal(inBandErrorWarning([1, 2]), undefined)
  assert.equal(inBandErrorWarning(undefined), undefined)
})

test('inBandErrorWarning ignores benign metadata keys so an error carrying a request_id is still caught', () => {
  const warning = inBandErrorWarning({ error: 'no such channel', request_id: 'req_123' })
  assert.match(warning ?? '', /no such channel/)
  assert.match(warning ?? '', /in-band tool error detected via key heuristic/)
})

test('inBandErrorWarning does not flag a legitimate success payload that happens to carry a status field', () => {
  assert.equal(inBandErrorWarning({ status: 'ok', id: 'req_123', data: { rows: 3 } }), undefined)
})
