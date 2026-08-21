import test from 'node:test'
import assert from 'node:assert/strict'
import {
  executionDuration,
  executionFailureSummary,
  executionIsDegraded,
  executionStepLabel,
  executionTriggerLabel,
} from '../execution-log'

test('executionFailureSummary prefers the run error, then failed step detail, then warnings', () => {
  const steps = [
    { nodeId: 'agent-1', status: 'failed', order: 0, error: 'Agent timed out', warnings: null },
    { nodeId: 'output-1', status: 'succeeded', order: 1, warnings: ['Output was empty'] },
  ]
  assert.equal(executionFailureSummary({ status: 'failed', error: 'Worker lost its lease', steps }), 'Worker lost its lease')
  assert.equal(executionFailureSummary({ status: 'failed', error: null, steps }), 'Agent timed out')
  assert.equal(
    executionFailureSummary({ status: 'succeeded', error: null, steps: steps.map((step) => ({ ...step, status: 'succeeded', error: null })) }),
    'Output was empty',
  )
  assert.equal(executionFailureSummary({ status: 'failed', error: null, steps: [] }), 'Run failed before an error detail was recorded.')
})

test('executionDuration formats milliseconds, seconds, minutes, and invalid ranges', () => {
  assert.equal(executionDuration({ startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T12:00:00.250Z' }), '250ms')
  assert.equal(executionDuration({ startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T12:00:03.250Z' }), '3.3s')
  assert.equal(executionDuration({ startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T12:01:03.000Z' }), '1m 3s')
  assert.equal(executionDuration({ startedAt: '2026-08-10T12:00:00.000Z', finishedAt: null }), '—')
  assert.equal(executionDuration({ startedAt: '2026-08-10T12:00:01.000Z', finishedAt: '2026-08-10T12:00:00.000Z' }), '—')
})

test('executionStepLabel resolves the immutable graph snapshot and fan-out item number', () => {
  const graph = {
    nodes: [
      { id: 'agent-1', type: 'agent', data: { label: 'Research account' } },
      { id: 'output-1', type: 'output', data: {} },
    ],
  }
  assert.equal(executionStepLabel(graph, 'agent-1'), 'Research account')
  assert.equal(executionStepLabel(graph, 'agent-1#2'), 'Research account · item 3')
  assert.equal(executionStepLabel(graph, 'output-1'), 'Output')
  assert.equal(executionStepLabel(null, 'missing-node'), 'missing-node')
})

test('execution health and trigger helpers describe degraded successes', () => {
  assert.equal(executionIsDegraded({ status: 'succeeded', steps: [{ nodeId: 'a', status: 'succeeded', order: 0, warnings: ['partial'] }] }), true)
  assert.equal(executionIsDegraded({ status: 'failed', steps: [{ nodeId: 'a', status: 'failed', order: 0 }] }), false)
  assert.equal(executionTriggerLabel({ type: 'webhook' }), 'Webhook')
  assert.equal(executionTriggerLabel(null), 'Manual')
})

test('executionIsDegraded prefers the persisted column over per-client inference, falling back only when it is absent', () => {
  const cleanSteps = [{ nodeId: 'a', status: 'succeeded', order: 0 }]
  const warnedSteps = [{ nodeId: 'a', status: 'succeeded', order: 0, warnings: ['partial'] }]

  // Persisted true wins even though the (possibly-truncated) steps look clean.
  assert.equal(executionIsDegraded({ status: 'succeeded', steps: cleanSteps, degraded: true }), true)
  // Persisted false wins even though steps look degraded — the column is
  // authoritative because it was computed over the FULL step set.
  assert.equal(executionIsDegraded({ status: 'succeeded', steps: warnedSteps, degraded: false }), false)
  // Absent (undefined) — not merely falsy — is what triggers the fallback:
  // pre-migration rows / older cached payloads never carried this field.
  assert.equal(executionIsDegraded({ status: 'succeeded', steps: warnedSteps }), true)
  assert.equal(executionIsDegraded({ status: 'succeeded', steps: cleanSteps }), false)
})
