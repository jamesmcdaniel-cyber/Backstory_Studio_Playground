import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumerVerdict, deadLetterVerdict, queuePressureVerdict, resolveQueueFreshness, QUEUE_BACKLOG_AGE_ALERT_MS, QUEUE_BACKLOG_COUNT_ALERT } from '../consumer-probe'
import { WORKER_HEARTBEAT_STALE_MS } from '../heartbeat'

const report = (queue: string, workers: number, waiting: number, active = 0) => ({ queue, workers, waiting, active })

test('all execution queues consumed → ok, nothing stranded', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 3, 0),
    report('scheduled-agent-execution', 3, 0),
    report('flow-execution', 3, 2, 1),
  ])
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.stranded, [])
})

test('a queue with zero consumers fails the verdict even while empty — the NEXT run would hang', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 2, 0),
    report('flow-execution', 0, 0),
  ])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.stranded, [], 'nothing waiting yet, so nothing stranded')
})

test('waiting jobs with zero consumers are reported as stranded — the acute alarm', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 0, 1),
    report('flow-execution', 0, 2),
  ])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.stranded, ['agent-execution', 'flow-execution'])
})

test('no reports (probe could not read the queues) → not ok', () => {
  assert.equal(consumerVerdict([]).ok, false)
})

test('fresh heartbeat overrides a zero worker count — CLIENT LIST on managed Redis proxies reports 0 while the fleet is draining fine', () => {
  const verdict = consumerVerdict(
    [report('agent-execution', 0, 0), report('flow-execution', 0, 1)],
    true,
  )
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.stranded, [], 'a live worker picks up waiting jobs — nothing is stranded')
})

test('fresh heartbeat does not rescue an unreadable probe (no reports)', () => {
  assert.equal(consumerVerdict([], true).ok, false)
})

test('queue-specific heartbeat cannot hide an unserved batch queue', () => {
  const verdict = consumerVerdict(
    [report('flow-execution', 0, 1), report('model-bench', 0, 1)],
    { 'flow-execution': true, 'model-bench': false },
  )
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.stranded, ['model-bench'])
})

test('queue pressure reports either excessive depth or an old waiting job', () => {
  const pressure = queuePressureVerdict([
    { ...report('flow-execution', 2, QUEUE_BACKLOG_COUNT_ALERT), oldestWaitingAgeMs: 1_000 },
    { ...report('agent-execution', 2, 1), oldestWaitingAgeMs: QUEUE_BACKLOG_AGE_ALERT_MS },
  ])
  assert.deepEqual(pressure.queues, ['flow-execution', 'agent-execution'])
  assert.match(pressure.reason ?? '', /oldest/)
})

test('stale heartbeat falls back to the registered-consumer verdict', () => {
  assert.equal(consumerVerdict([report('flow-execution', 0, 0)], false).ok, false)
  assert.equal(consumerVerdict([report('flow-execution', 1, 0)], false).ok, true)
})

test('dead-letter verdict totals waiting jobs across DLQs and names the non-empty ones', () => {
  const verdict = deadLetterVerdict([
    { queue: 'agent-dead-letter', waiting: 0 },
    { queue: 'flow-dead-letter', waiting: 3 },
    { queue: 'template-generation-dead-letter', waiting: 1 },
  ])
  assert.equal(verdict.total, 4)
  assert.deepEqual(verdict.queues, ['flow-dead-letter', 'template-generation-dead-letter'])
})

test('empty dead-letter queues → zero total, no queues named', () => {
  const verdict = deadLetterVerdict([
    { queue: 'agent-dead-letter', waiting: 0 },
    { queue: 'flow-dead-letter', waiting: 0 },
  ])
  assert.equal(verdict.total, 0)
  assert.deepEqual(verdict.queues, [])
})

// ── Freshness resolution: "we could not read" is not "nobody is there" ──────
//
// On Upstash, getWorkers() reports 0 for every queue while the fleet drains
// normally (see consumerVerdict's header). That makes the per-queue heartbeat
// the ONLY signal holding `ok` up — so whatever the heartbeat read returns on a
// bad day is, by itself, the difference between healthy and a page.
//
// workerQueueHeartbeatAges answered a failed read with a map of nulls, which is
// byte-identical to "no worker has ever written one". A single slow MGET
// therefore condemned a healthy fleet, and because idle queues have nothing
// waiting, the alert came out as the contentless "queue consumer check failed".
// resolveQueueFreshness is where that distinction now lives.

test('a per-queue heartbeat read that FAILED falls back to the global heartbeat rather than reading as dead', () => {
  // The dispatch gate already resolves it this way (resolveConsumerAlive: a
  // failed read is "unknown", not "dead"). The probe was strictly weaker
  // against the identical failure, which is what made it cry wolf.
  const fresh = resolveQueueFreshness({
    queues: ['flow-execution', 'model-bench'],
    ages: { 'flow-execution': null, 'model-bench': null },
    readOk: false,
    globalFresh: true,
  })
  assert.deepEqual(fresh, { 'flow-execution': true, 'model-bench': true })
})

test('a FAILED read with no global heartbeat either is still not fresh — knowing nothing twice is not reassurance', () => {
  const fresh = resolveQueueFreshness({
    queues: ['flow-execution'],
    ages: { 'flow-execution': null },
    readOk: false,
    globalFresh: false,
  })
  assert.deepEqual(fresh, { 'flow-execution': false })
})

test('a SUCCESSFUL read keeps a genuinely absent per-queue heartbeat unfresh, so a dead batch pool still alerts', () => {
  // The regression that matters. The global heartbeat is written by the
  // interactive worker, so falling back to it unconditionally would mask
  // exactly the outage the per-queue keys were introduced to catch.
  const fresh = resolveQueueFreshness({
    queues: ['flow-execution', 'model-bench'],
    ages: { 'flow-execution': 1_000, 'model-bench': null },
    readOk: true,
    globalFresh: true,
  })
  assert.deepEqual(fresh, { 'flow-execution': true, 'model-bench': false })
})

test('a SUCCESSFUL read treats an ageing heartbeat as stale once it passes the threshold', () => {
  const fresh = resolveQueueFreshness({
    queues: ['flow-execution', 'agent-execution'],
    ages: { 'flow-execution': WORKER_HEARTBEAT_STALE_MS + 1, 'agent-execution': WORKER_HEARTBEAT_STALE_MS },
    readOk: true,
    globalFresh: false,
  })
  assert.deepEqual(fresh, { 'flow-execution': false, 'agent-execution': true }, 'the threshold is inclusive')
})
