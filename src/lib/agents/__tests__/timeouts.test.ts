import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_MODEL_TURN_TIMEOUT_MS,
  AGENT_RUN_MAX_DURATION_SECONDS,
  AGENT_RUN_TIMEOUT_MS,
} from '../timeouts'

test('agent execution timeout constants allow 30 minute runs', () => {
  assert.equal(AGENT_RUN_MAX_DURATION_SECONDS, 1800)
  assert.equal(AGENT_RUN_TIMEOUT_MS, 1_800_000)
  assert.equal(AGENT_MODEL_TURN_TIMEOUT_MS, 1_680_000)
})

test('a model turn leaves slack inside the run window for persistence/cleanup', () => {
  assert.ok(AGENT_MODEL_TURN_TIMEOUT_MS < AGENT_RUN_TIMEOUT_MS)
})
