'use client'

import { useEffect, useRef } from 'react'
import { subscribeTicks } from '@/lib/client/realtime'
import { agentExecChannel } from '@/lib/flows/run-stream'

/** Realtime ticks for an agent execution (`agent-exec:<id>`): every event the
 *  run records, and its final status. No-op without Supabase — the poll
 *  fallback still drives updates. */
export function useAgentExecStream(executionId: string | null | undefined, onTick: () => void, enabled = true) {
  const cb = useRef(onTick)
  cb.current = onTick
  useEffect(() => {
    if (!enabled || !executionId) return
    // Shared: the artifact page and the run feed inside it follow the same run.
    return subscribeTicks(agentExecChannel(executionId), () => cb.current())
  }, [executionId, enabled])
}
