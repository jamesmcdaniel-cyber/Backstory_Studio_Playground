'use client'

import { useEffect, useRef } from 'react'
import { subscribeTicks } from '@/lib/client/realtime'
import { flowRunChannel } from '@/lib/flows/run-stream'

/**
 * Subscribe to a run's realtime channel and invoke `onTick` whenever a step
 * changes on the server, so the builder refreshes immediately instead of waiting
 * for its poll. Degrades to a no-op when Supabase isn't configured (the poll
 * still runs). `onTick` is held in a ref so it never forces a resubscribe.
 */
export function useFlowRunStream(runId: string | null | undefined, onTick: () => void, enabled = true) {
  const cb = useRef(onTick)
  cb.current = onTick
  useEffect(() => {
    if (!enabled || !runId) return
    return subscribeTicks(flowRunChannel(runId), () => cb.current())
  }, [runId, enabled])
}
