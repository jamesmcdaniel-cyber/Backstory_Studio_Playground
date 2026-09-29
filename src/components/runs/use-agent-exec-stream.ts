'use client'

import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { agentExecChannel } from '@/lib/flows/run-stream'

/** Realtime ticks for an agent execution (`agent-exec:<id>`): every event the
 *  run records, and its final status. No-op without Supabase — the poll
 *  fallback still drives updates. */
export function useAgentExecStream(executionId: string | null | undefined, onTick: () => void, enabled = true) {
  const cb = useRef(onTick)
  cb.current = onTick
  useEffect(() => {
    if (!enabled || !executionId) return
    let supabase: ReturnType<typeof createClient>
    try {
      supabase = createClient()
    } catch {
      return
    }
    const channel = supabase.channel(agentExecChannel(executionId))
    channel.on('broadcast', { event: 'tick' }, () => cb.current()).subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [executionId, enabled])
}
