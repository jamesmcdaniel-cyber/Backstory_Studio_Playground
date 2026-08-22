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
})
