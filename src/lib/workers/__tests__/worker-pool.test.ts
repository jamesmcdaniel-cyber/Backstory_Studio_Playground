import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildWorkerSpecs, resolveWorkerPool } from '@/lib/workers/runtime'
import { QUEUE_NAMES } from '@/lib/queue/config'

const queues = (specs: ReturnType<typeof buildWorkerSpecs>) => specs.map((spec) => spec.queue).sort()

describe('resolveWorkerPool', () => {
  it('defaults to consuming everything', () => {
    // The pre-split behaviour, and what every existing deployment does until
    // someone sets WORKER_POOL on each app. A default that consumed a subset
    // would strand queues on upgrade.
    assert.equal(resolveWorkerPool(undefined), 'all')
    assert.equal(resolveWorkerPool(''), 'all')
  })

  it('accepts the two real pools', () => {
    assert.equal(resolveWorkerPool('interactive'), 'interactive')
    assert.equal(resolveWorkerPool('batch'), 'batch')
  })

  it('falls back to all on a typo rather than consuming nothing', () => {
    // The dangerous failure is a fleet that boots healthy, reports a heartbeat,
    // and consumes queues nobody writes to. Consuming everything is wasteful;
    // consuming nothing is an outage that looks fine.
    assert.equal(resolveWorkerPool('Interactive'), 'all')
    assert.equal(resolveWorkerPool('inteactive'), 'all')
  })
})

describe('buildWorkerSpecs', () => {
  it('gives the interactive pool exactly the queues a person waits on', () => {
    assert.deepEqual(queues(buildWorkerSpecs(false, 'interactive')), [
      QUEUE_NAMES.AGENT_EXECUTION,
      QUEUE_NAMES.FLOW_EXECUTION,
      QUEUE_NAMES.SCHEDULED_AGENT_EXECUTION,
    ].sort())
  })

  it('gives the batch pool the long operator jobs', () => {
    assert.deepEqual(queues(buildWorkerSpecs(false, 'batch')), [
      QUEUE_NAMES.ACTIVITY_BACKFILL,
      QUEUE_NAMES.MODEL_BENCH,
      QUEUE_NAMES.TEMPLATE_GENERATION,
    ].sort())
  })

  it('partitions — every queue is served by exactly one pool', () => {
    // The property that matters operationally: a queue in neither pool is work
    // that silently never runs once the split is deployed.
    const everything = queues(buildWorkerSpecs(false, 'all'))
    const split = queues([...buildWorkerSpecs(false, 'interactive'), ...buildWorkerSpecs(false, 'batch')])
    assert.deepEqual(split, everything)
    assert.equal(new Set(split).size, split.length, 'a queue is consumed by both pools')
  })

  it('caps batch concurrency below the interactive default', () => {
    // A bench at the interactive queues' concurrency is how a 1 GB machine
    // reaches its memory ceiling.
    for (const spec of buildWorkerSpecs(false, 'batch')) {
      assert.ok(spec.concurrency && spec.concurrency <= 2, `${spec.queue} has no batch concurrency cap`)
    }
    for (const spec of buildWorkerSpecs(false, 'interactive')) {
      assert.equal(spec.concurrency, undefined, `${spec.queue} should use the shared default`)
    }
  })

  it('leaves the customer edition with no batch pool to deploy', () => {
    // The customer edition never enqueues these, so a batch app there would
    // idle forever — fly.worker-batch.toml says so, and this pins it.
    assert.deepEqual(buildWorkerSpecs(true, 'batch'), [])
    assert.deepEqual(queues(buildWorkerSpecs(true, 'all')), queues(buildWorkerSpecs(true, 'interactive')))
  })
})
