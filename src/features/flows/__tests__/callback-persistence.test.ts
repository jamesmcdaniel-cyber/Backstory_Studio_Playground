import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonValue } from '../run-step-persistence'

test('callback capabilities never persist in nested run output or JSON strings', () => {
  const url = 'https://app.example/api/flows/flow1/runs/run1/resume?token=qa-test-token&other=1'
  const result = jsonValue({ callback: { url }, nested: JSON.stringify({ url }) })
  assert.doesNotMatch(JSON.stringify(result), /qa-test-token/)
  assert.match(result.callback.url, /token=\[redacted\]&other=1/)
  assert.equal(jsonValue({ value: 7 }).value, 7)
})
