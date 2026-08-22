import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runQueueWatch, queueWatchReason, type QueueWatchDeps } from '../queue-watch'
import type { QueueConsumerCheck } from '../consumer-probe'

const healthy: QueueConsumerCheck = {
  configured: true,
  ok: true,
  stranded: [],
  deadLetters: { total: 0, queues: [] },
}

const unhealthy: QueueConsumerCheck = {
  configured: true,
  ok: false,
  stranded: ['agent-execution'],
  deadLetters: { total: 0, queues: [] },
}

const withDeadLetters: QueueConsumerCheck = {
  configured: true,
  ok: true,
  stranded: [],
  deadLetters: { total: 3, queues: ['flow-dead-letter'] },
}

const bothUnhealthy: QueueConsumerCheck = {
  configured: true,
  ok: false,
  stranded: ['agent-execution'],
  deadLetters: { total: 2, queues: ['agent-dead-letter'] },
}

/** Consumer loss recovered, dead letters still present. */
const dlqOnlyStillPresent: QueueConsumerCheck = {
  configured: true,
  ok: true,
  stranded: [],
  deadLetters: { total: 2, queues: ['agent-dead-letter'] },
}

function harness(sequence: QueueConsumerCheck[]) {
  const store = new Map<string, boolean>()
  const notified: unknown[] = []
  const audited: unknown[] = []
  let call = 0

  const deps: Partial<QueueWatchDeps> = {
    probe: async () => sequence[Math.min(call++, sequence.length - 1)],
    cacheGetFn: async (key) => (store.has(key) ? (store.get(key) as boolean) : null),
    cacheSetFn: async (key, value) => {
      store.set(key, value)
    },
    cacheDeleteFn: async (key) => {
      store.delete(key)
    },
    findOwners: async () => [{ id: 'owner-1', organizationId: 'org-owner' }],
    notifyFn: (async (input: unknown) => {
      notified.push(input)
      return null
    }) as QueueWatchDeps['notifyFn'],
    recordAuditFn: (async (input: unknown) => {
      audited.push(input)
    }) as QueueWatchDeps['recordAuditFn'],
  }
  return { deps, store, notified, audited }
}

describe('queueWatchReason', () => {
  test('unconfigured is never alertable', () => {
    assert.equal(queueWatchReason({ configured: false, ok: true, stranded: [] }), null)
  })
  test('healthy with no dead letters is not alertable', () => {
    assert.equal(queueWatchReason(healthy), null)
  })
  test('consumer loss is alertable', () => {
    assert.match(queueWatchReason(unhealthy) ?? '', /agent-execution/)
  })
  test('dead letters alone are alertable even when consumers are ok', () => {
    assert.match(queueWatchReason(withDeadLetters) ?? '', /3 job/)
  })
})

describe('runQueueWatch', () => {
  test('healthy tick: no alert, nothing notified', async () => {
    const { deps, notified, audited } = harness([healthy])
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, false)
    assert.equal(result.alerted, false)
    assert.equal(notified.length, 0)
    assert.equal(audited.length, 0)
  })

  test('unhealthy tick fires exactly one alert to the platform owner', async () => {
    const { deps, notified, audited } = harness([unhealthy])
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, true)
    assert.equal(result.alerted, true)
    assert.equal(notified.length, 1)
    assert.equal(audited.length, 1)
    assert.equal((audited[0] as { action: string }).action, 'platform.queue.alert')
    assert.equal((notified[0] as { organizationId: string }).organizationId, 'org-owner')
  })

  test('second unhealthy tick within the cooldown does NOT re-alert', async () => {
    const { deps, notified } = harness([unhealthy, unhealthy])
    const first = await runQueueWatch(deps)
    const second = await runQueueWatch(deps)
    assert.equal(first.alerted, true)
    assert.equal(second.unhealthy, true)
    assert.equal(second.alerted, false, 'still within cooldown — must not re-alert the same incident')
    assert.equal(notified.length, 1, 'only the first tick notified')
  })

  test('recovery clears the cooldown, and a fresh break alerts again immediately', async () => {
    const { deps, notified } = harness([unhealthy, healthy, unhealthy])
    const broke = await runQueueWatch(deps)
    const recovered = await runQueueWatch(deps)
    const brokeAgain = await runQueueWatch(deps)
    assert.equal(broke.alerted, true)
    assert.equal(recovered.unhealthy, false)
    assert.equal(brokeAgain.unhealthy, true)
    assert.equal(brokeAgain.alerted, true, 'a NEW incident after recovery must alert, not stay silent under a stale cooldown')
    assert.equal(notified.length, 2, 'one notification per distinct incident')
  })

  test('dead-letter backlog alone triggers an alert', async () => {
    const { deps, notified } = harness([withDeadLetters])
    const result = await runQueueWatch(deps)
    assert.equal(result.alerted, true)
    assert.match(result.reason ?? '', /dead-letter/)
    assert.equal(notified.length, 1)
  })

  test('no owners found: still reports unhealthy without throwing', async () => {
    const { deps } = harness([unhealthy])
    deps.findOwners = async () => []
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, true)
    assert.equal(result.alerted, true)
  })

  test('cross-condition: a consumer-loss alert must not suppress a dead-letter alert that starts within the same hour', async () => {
    // Tick 1: consumer loss only -> alert 1, and its cooldown key is set.
    // Tick 2 (still within the hour): consumers recovered, but dead letters
    // are now present -- a DIFFERENT condition, with its own cooldown key
    // that has never been set, so it must fire alert 2 rather than being
    // masked by the still-live consumer-loss cooldown.
    const { deps, notified } = harness([unhealthy, withDeadLetters])
    const first = await runQueueWatch(deps)
    const second = await runQueueWatch(deps)
    assert.equal(first.alerted, true, 'consumer-loss alert fires')
    assert.match(first.reason ?? '', /agent-execution/)
    assert.equal(second.alerted, true, 'dead-letter alert must fire — previously masked by the shared cooldown')
    assert.match(second.reason ?? '', /dead-letter/)
    assert.equal(notified.length, 2, 'one notification per condition, not suppressed by the other')
  })

  test('each condition\'s cooldown clears independently on its own recovery', async () => {
    const { deps, notified } = harness([bothUnhealthy, bothUnhealthy, dlqOnlyStillPresent, bothUnhealthy])

    // Assertions are interleaved between ticks (rather than batched at the
    // end) so each `notified.length` check reflects state at that point in
    // time, not after every tick has already run.
    const tick1 = await runQueueWatch(deps) // both conditions newly unhealthy -> 2 alerts
    assert.equal(tick1.alerted, true)
    assert.equal(notified.length, 2, 'tick 1: both conditions alert independently')

    const tick2 = await runQueueWatch(deps) // both still unhealthy, both within cooldown -> 0 alerts
    assert.equal(tick2.unhealthy, true)
    assert.equal(tick2.alerted, false, 'tick 2: both conditions still within their own cooldowns')
    assert.equal(notified.length, 2)

    const tick3 = await runQueueWatch(deps) // consumer loss recovered (clears its key); dlq still in cooldown -> 0 alerts
    assert.equal(tick3.unhealthy, true, 'dead letters alone keep this tick unhealthy')
    assert.equal(tick3.alerted, false, 'tick 3: consumer loss recovered (no alert to fire); dlq still cooling down')
    assert.equal(notified.length, 2)

    const tick4 = await runQueueWatch(deps) // consumer loss breaks AGAIN (fresh incident, key was cleared); dlq still in cooldown -> 1 alert
    assert.equal(tick4.alerted, true, 'tick 4: consumer loss is a NEW incident (its cooldown was cleared on recovery) — must alert regardless of the dlq cooldown state')
    assert.equal(notified.length, 3, 'only the consumer-loss condition alerted again — dlq is still within its own cooldown')
  })
})
