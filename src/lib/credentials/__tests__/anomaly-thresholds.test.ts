import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BASELINE_WINDOW_MS, RECENT_WINDOW_MS } from '../anomaly'

/**
 * The detection logic itself reads the audit table, so it is exercised in the
 * DB-backed suite. What is worth pinning without a database are the properties
 * that decide whether anyone keeps the detector switched on.
 *
 * Every threshold here exists to prevent a specific false positive. A detector
 * that cries wolf gets muted, and a muted detector is strictly worse than none
 * — it costs the same and provides false assurance.
 */

test('the baseline window is much longer than the recent window', () => {
  // Comparing an hour against an hour makes every busy afternoon an anomaly.
  // The baseline has to be long enough to contain a normal working rhythm.
  assert.ok(
    BASELINE_WINDOW_MS >= RECENT_WINDOW_MS * 24,
    'the baseline must span far more than the recent window to mean anything',
  )
})

test('the recent window is short enough to be actionable', () => {
  // A day-long window would average a spike away into nothing.
  assert.ok(RECENT_WINDOW_MS <= 6 * 60 * 60 * 1000, 'recent must stay narrow enough for a spike to show')
})

test('the module documents which signal it deliberately does NOT implement', () => {
  // "New host" is the canonical credential anomaly and it is already impossible
  // here — HttpCredential is pinned to allowedHost. Implementing it anyway
  // would report a class of event that cannot occur and imply, by association,
  // that the others are equally covered. The reasoning has to survive in the
  // file or the next person will "fix" the omission.
  const source = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'src/lib/credentials/anomaly.ts'),
    'utf8',
  ) as string

  assert.match(source, /allowedHost/, 'the host-pinning rationale must stay documented')
  assert.match(source, /NOT detected/i)
})

test('the sweep never throws — a detector must not break the scheduler', () => {
  // It runs inside the dispatch tick, which also dispatches every scheduled
  // agent and flow in the platform. An exception escaping this would trade a
  // missed anomaly for a stopped scheduler.
  const source = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'src/lib/credentials/anomaly.ts'),
    'utf8',
  ) as string

  const sweep = source.slice(source.indexOf('export async function sweepCredentialAnomalies'))
  assert.match(sweep, /try\s*\{/, 'the sweep must catch its own failures')
  assert.match(sweep, /catch/)
})

test('the tick calls the sweep defensively as well', () => {
  const tick = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'src/lib/scheduling/dispatch-tick.ts'),
    'utf8',
  ) as string

  assert.match(tick, /sweepCredentialAnomalies\(\)\.catch\(/, 'the tick must not depend on the sweep succeeding')
})
