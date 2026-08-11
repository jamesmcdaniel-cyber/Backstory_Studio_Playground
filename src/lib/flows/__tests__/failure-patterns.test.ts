import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectFailurePatterns, normalizeErrorSignature, type PatternRun } from '../failure-patterns'

/**
 * A flow that failed the same way every 15 minutes produced 96 identical failed
 * runs a day and no signal — no proposal, no checker rule, nothing. Agents have
 * reflected since day one; flows never did.
 *
 * Grouping ACROSS runs is what makes reflection affordable (one call per flow
 * with a pattern, not one per run) and is also the only way to see a trend at
 * all. This is likewise the first consumer of FlowRunStep.warnings.
 */

function run(id: string, day: number, steps: PatternRun['steps']): PatternRun {
  return { id, startedAt: new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`), steps }
}
const failed = (nodeId: string, error: string) => ({ nodeId, status: 'failed', error, warnings: [] })
const warned = (nodeId: string, warning: string) => ({
  nodeId,
  status: 'succeeded',
  error: null,
  warnings: [warning],
})

test('ids, urls, uuids, and bare numbers collapse into one signature', () => {
  assert.equal(
    normalizeErrorSignature('404 Not Found for https://api.example.com/users/abc123def456ghi'),
    normalizeErrorSignature('404 Not Found for https://api.example.com/users/zzz999yyy888www'),
  )
})

test('genuinely different errors do NOT collapse', () => {
  assert.notEqual(
    normalizeErrorSignature('404 Not Found for /users/1'),
    normalizeErrorSignature('503 Service Unavailable for /users/1'),
  )
})

test('the status code survives normalization — it is the useful part', () => {
  assert.match(normalizeErrorSignature('HTTP 503 from upstream'), /503/)
})

test('a pattern fires at three occurrences across three runs', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [failed('fetch', '404 for /users/1')]),
    run('r2', 2, [failed('fetch', '404 for /users/2')]),
    run('r3', 3, [failed('fetch', '404 for /users/3')]),
  ])
  assert.equal(patterns.length, 1)
  assert.equal(patterns[0].stepId, 'fetch')
  assert.equal(patterns[0].kind, 'error')
  assert.equal(patterns[0].occurrences, 3)
  assert.deepEqual(patterns[0].runIds, ['r1', 'r2', 'r3'])
})

test('two occurrences is below the threshold — no pattern', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [failed('fetch', '404 for /users/11')]),
    run('r2', 2, [failed('fetch', '404 for /users/22')]),
  ])
  assert.deepEqual(patterns, [])
})

test('three occurrences inside ONE run is not a pattern — a loop is not a trend', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [
      failed('fetch', '404 for /users/11'),
      failed('fetch', '404 for /users/22'),
      failed('fetch', '404 for /users/33'),
    ]),
  ])
  assert.deepEqual(patterns, [])
})

test('warnings form their own patterns, keyed separately from errors', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [warned('send', 'The tool returned an empty result.')]),
    run('r2', 2, [warned('send', 'The tool returned an empty result.')]),
    run('r3', 3, [warned('send', 'The tool returned an empty result.')]),
  ])
  assert.equal(patterns.length, 1)
  assert.equal(patterns[0].kind, 'warning')
})

test('a failed step and a warned step on the same node are separate patterns', () => {
  const both = (nodeId: string) => [failed(nodeId, 'boom'), warned(nodeId, 'empty result')]
  const patterns = detectFailurePatterns([
    run('r1', 1, both('x')),
    run('r2', 2, both('x')),
    run('r3', 3, both('x')),
  ])
  assert.equal(patterns.length, 2)
  assert.deepEqual(new Set(patterns.map((p) => p.kind)), new Set(['error', 'warning']))
})

test('different steps failing the same way are separate patterns', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r2', 2, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r3', 3, [failed('a', '500 x'), failed('b', '500 x')]),
  ])
  assert.equal(patterns.length, 2)
})

test('a clean history produces nothing', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [{ nodeId: 'fetch', status: 'succeeded', error: null, warnings: [] }]),
  ])
  assert.deepEqual(patterns, [])
})

test('a failed step with no error message is not a pattern', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [{ nodeId: 'fetch', status: 'failed', error: null, warnings: [] }]),
    run('r2', 2, [{ nodeId: 'fetch', status: 'failed', error: '', warnings: [] }]),
    run('r3', 3, [{ nodeId: 'fetch', status: 'failed', error: null, warnings: [] }]),
  ])
  assert.deepEqual(patterns, [])
})

test('firstSeen and lastSeen bracket the pattern', () => {
  const [pattern] = detectFailurePatterns([
    run('r1', 1, [failed('fetch', '404 for /users/11')]),
    run('r2', 5, [failed('fetch', '404 for /users/22')]),
    run('r3', 9, [failed('fetch', '404 for /users/33')]),
  ])
  assert.equal(pattern.firstSeen.toISOString(), '2026-08-01T09:00:00.000Z')
  assert.equal(pattern.lastSeen.toISOString(), '2026-08-09T09:00:00.000Z')
})

test('patterns come back most-frequent first', () => {
  const patterns = detectFailurePatterns([
    run('r1', 1, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r2', 2, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r3', 3, [failed('a', '500 x'), failed('b', '500 x')]),
    run('r4', 4, [failed('a', '500 x')]),
  ])
  assert.equal(patterns[0].stepId, 'a')
  assert.equal(patterns[0].occurrences, 4)
})

test('thresholds are overridable so the sweep can tune without a rewrite', () => {
  const runs = [run('r1', 1, [failed('fetch', 'boom')]), run('r2', 2, [failed('fetch', 'boom')])]
  assert.deepEqual(detectFailurePatterns(runs), [])
  assert.equal(detectFailurePatterns(runs, { minOccurrences: 2 }).length, 1)
})

test('an empty history is handled without throwing', () => {
  assert.deepEqual(detectFailurePatterns([]), [])
})
