'use client'

import { useEffect, useState } from 'react'

/**
 * Queue-plane health for the flow builder. /api/health already proves (or
 * disproves) that the execution backend is consuming — this surfaces that
 * verdict as a banner so the person clicking Run learns in seconds what the
 * 2026-08-04 outage took hours to dig out. Silent in inline mode.
 */

export interface QueueConsumersCheck {
  configured?: boolean
  ok?: boolean
  stranded?: string[]
  heartbeat?: { ageMs: number | null; fresh: boolean }
}

/** Pure alert derivation — null means "nothing to show". */
export function queueHealthAlert(check: QueueConsumersCheck | null | undefined): string | null {
  // No payload (client offline, health fetch failed) is not evidence of a
  // backend outage — stay silent rather than cry wolf on flaky wifi.
  if (!check || !check.configured) return null
  if (check.ok === false) {
    return check.stranded?.length
      ? 'Runs are queued but no worker is consuming them — new runs will not start. Contact an operator.'
      : 'The execution backend is offline — runs will not start. Contact an operator.'
  }
  // A stale/missing heartbeat with consumers registered is NOT an alarm: a
  // worker image predating the heartbeat writer consumes fine. The consumers
  // verdict (ok) covers every stranding case this banner exists for; the
  // heartbeat stays monitor data (/api/health), never a user-facing red pill.
  return null
}

const CHECK_INTERVAL_MS = 60_000

/** Polls /api/health once a minute (skipping hidden tabs) and returns the alert. */
export function useQueueHealth(): string | null {
  const [alert, setAlert] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      // 503 (unhealthy) still carries the JSON body — parse regardless of status.
      const body = await fetch('/api/health', { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
      if (cancelled) return
      setAlert(queueHealthAlert(body?.checks?.queueConsumers ?? null))
    }
    void check()
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return alert
}
