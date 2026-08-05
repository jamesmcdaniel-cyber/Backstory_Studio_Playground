import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { queueHealthAlert } from '@/components/flows/use-queue-health'

describe('queueHealthAlert', () => {
  it('silent when the queue plane is not configured (inline mode)', () => {
    assert.equal(queueHealthAlert({ configured: false, ok: true, stranded: [] }), null)
  })

  it('silent when consumers are live and the heartbeat is fresh', () => {
    assert.equal(
      queueHealthAlert({ configured: true, ok: true, stranded: [], heartbeat: { ageMs: 10_000, fresh: true } }),
      null,
    )
  })

  it('names stranded work when jobs are waiting with no consumer', () => {
    const alert = queueHealthAlert({ configured: true, ok: false, stranded: ['flow-execution'] })
    assert.match(alert ?? '', /no worker is consuming/i)
  })

  it('reports an offline backend when consumers are missing but nothing is queued yet', () => {
    const alert = queueHealthAlert({ configured: true, ok: false, stranded: [] })
    assert.match(alert ?? '', /offline/i)
  })

  it('silent on a missing/stale heartbeat while consumers are registered — a worker image predating the heartbeat writer is healthy, not offline', () => {
    // The production false alarm: the deployed worker consumed fine but wrote
    // no heartbeat yet, and the banner said "Execution backend offline". The
    // consumers verdict (ok) already covers every stranding case the banner
    // exists for; the heartbeat is monitor data, not a user-facing alarm.
    assert.equal(queueHealthAlert({ configured: true, ok: true, stranded: [], heartbeat: { ageMs: null, fresh: false } }), null)
    assert.equal(queueHealthAlert({ configured: true, ok: true, stranded: [], heartbeat: { ageMs: 10 * 60_000, fresh: false } }), null)
  })

  it('silent when the health payload is missing entirely (client offline ≠ backend outage)', () => {
    assert.equal(queueHealthAlert(null), null)
    assert.equal(queueHealthAlert(undefined), null)
  })
})
