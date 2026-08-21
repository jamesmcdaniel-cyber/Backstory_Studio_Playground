import test from 'node:test'
import assert from 'node:assert/strict'
import { runIsDegraded } from '../run-panel'

test('runIsDegraded prefers the persisted column over per-client inference, falling back only when it is absent', () => {
  const cleanSteps = [{ status: 'succeeded' }]
  const warnedSteps = [{ status: 'succeeded', warnings: ['partial'] }]

  // Persisted true wins even though the (possibly-truncated) steps look clean.
  assert.equal(runIsDegraded('succeeded', cleanSteps, true), true)
  // Persisted false wins even though steps look degraded — the column is
  // authoritative because it was computed over the FULL step set.
  assert.equal(runIsDegraded('succeeded', warnedSteps, false), false)
  // Absent (undefined) — not merely falsy — is what triggers the fallback:
  // pre-migration rows / older cached payloads never carried this field.
  assert.equal(runIsDegraded('succeeded', warnedSteps), true)
  assert.equal(runIsDegraded('succeeded', cleanSteps), false)
  assert.equal(runIsDegraded('failed', warnedSteps), false)
})
