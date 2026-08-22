import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { runQueueWatch, queueWatchReason, strandedActivityClaimsReason, type QueueWatchDeps } from '../queue-watch'
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

function harness(sequence: QueueConsumerCheck[], strandedClaimCounts: number[] = []) {
  const store = new Map<string, boolean>()
  const notified: unknown[] = []
  const audited: unknown[] = []
  let call = 0
  let claimCall = 0

  const deps: Partial<QueueWatchDeps> = {
    probe: async () => sequence[Math.min(call++, sequence.length - 1)],
    // Healthy (0) by default in every existing test below — none of them are
    // about the stranded-claims condition, so it must never contribute an
    // alert unless a test explicitly passes its own count sequence.
    countStrandedActivityClaims: async () =>
      strandedClaimCounts.length ? strandedClaimCounts[Math.min(claimCall++, strandedClaimCounts.length - 1)] : 0,
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

describe('strandedActivityClaimsReason', () => {
  test('a fresh count of 0 is not alertable', () => {
    assert.equal(strandedActivityClaimsReason(0), null)
  })
  test('any positive count is alertable and names the count', () => {
    assert.match(strandedActivityClaimsReason(2) ?? '', /2 activity-dispatch claim/)
  })
})

describe('runQueueWatch: stranded activity-dispatch claims', () => {
  test('a stale claimed row (count > 0) alerts, with the queue plane otherwise healthy', async () => {
    const { deps, notified } = harness([healthy], [1])
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, true)
    assert.equal(result.alerted, true)
    assert.match(result.reason ?? '', /activity-dispatch claim/)
    assert.equal(notified.length, 1)
  })

  test('a fresh claimed row (count 0) does not alert', async () => {
    const { deps, notified } = harness([healthy], [0])
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, false)
    assert.equal(result.alerted, false)
    assert.equal(notified.length, 0)
  })

  test('a countStrandedActivityClaims failure fails safe (no alert), rather than taking the tick down', async () => {
    const { deps, notified } = harness([healthy])
    deps.countStrandedActivityClaims = async () => {
      throw new Error('db down')
    }
    const result = await runQueueWatch(deps)
    assert.equal(result.unhealthy, false)
    assert.equal(notified.length, 0)
  })

  test('per-condition independence: a stranded-claims alert does not suppress, and is not suppressed by, consumer-loss or dead-letter alerts', async () => {
    // Tick 1: consumer loss AND stranded claims are both newly unhealthy —
    // two independent alerts, neither masking the other.
    const { deps, notified } = harness([unhealthy, unhealthy], [1, 1])
    const first = await runQueueWatch(deps)
    assert.equal(first.alerted, true)
    assert.equal(notified.length, 2, 'tick 1: consumer-loss and stranded-claims each alert independently')

    // Tick 2: consumer loss still within its cooldown (quiet), but stranded
    // claims is ALSO still within ITS OWN cooldown — own gate, not reset by
    // the other condition's state.
    const second = await runQueueWatch(deps)
    assert.equal(second.unhealthy, true)
    assert.equal(second.alerted, false, 'both conditions are within their own, independent cooldowns')
    assert.equal(notified.length, 2)
  })

  test('stranded claims recovering (count back to 0) clears its cooldown independently of the queue-plane conditions', async () => {
    const { deps, notified } = harness([unhealthy, unhealthy, unhealthy], [1, 0, 1])
    await runQueueWatch(deps) // consumer loss + stranded claims both alert
    assert.equal(notified.length, 2)
    const second = await runQueueWatch(deps) // stranded claims recovered; consumer loss still in cooldown
    assert.equal(second.unhealthy, true, 'consumer loss alone keeps this tick unhealthy')
    assert.equal(notified.length, 2, 'no new alert — consumer loss is cooling down, stranded claims recovered')
    const third = await runQueueWatch(deps) // stranded claims breaks again — a NEW incident, must alert
    assert.equal(third.alerted, true)
    assert.equal(notified.length, 3, 'stranded claims alerts again on its fresh incident, independent of consumer loss')
  })
})
