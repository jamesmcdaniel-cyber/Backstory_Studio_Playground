'use client'

import type { RealtimeChannel } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'

/**
 * Shared realtime "tick" subscriptions.
 *
 * The browser Supabase client is a singleton, and `client.channel(topic)`
 * hands every caller the SAME channel object for a topic. Two components
 * following the same run — an artifact page and the run feed inside it —
 * each calling `.subscribe()` on it is "tried to subscribe multiple times",
 * which throws and took the whole page down. So: one channel per topic,
 * subscribed once, fanned out to every listener; torn down a moment after
 * the last listener leaves (an unmount followed by an immediate remount
 * reuses it instead of racing the removal).
 */

type RealtimeClient = Pick<ReturnType<typeof createClient>, 'channel' | 'removeChannel'>

type Entry = {
  client: RealtimeClient
  channel: RealtimeChannel
  listeners: Set<() => void>
  teardown: ReturnType<typeof setTimeout> | null
}

const shared = new Map<string, Entry>()
const TEARDOWN_DELAY_MS = 1_000

/** Call `onTick` on every broadcast "tick" on `topic`. Returns the unsubscribe. No-op without Supabase. */
export function subscribeTicks(topic: string, onTick: () => void, clientFactory: () => RealtimeClient = createClient): () => void {
  let entry = shared.get(topic)
  if (!entry) {
    let client: RealtimeClient
    try {
      client = clientFactory()
    } catch {
      return () => {} // no Supabase configured — the poll fallback drives updates
    }
    const listeners = new Set<() => void>()
    const channel = client.channel(topic)
    channel.on('broadcast', { event: 'tick' }, () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // one listener's failure must not starve the others
        }
      }
    })
    // Subscribe only a channel nobody has joined (the client may return one
    // another code path already holds).
    if (channel.state === 'closed') {
      try {
        channel.subscribe()
      } catch {
        // already subscribed elsewhere — its broadcasts still reach the handler above
      }
    }
    entry = { client, channel, listeners, teardown: null }
    shared.set(topic, entry)
  }
  if (entry.teardown) {
    clearTimeout(entry.teardown)
    entry.teardown = null
  }
  entry.listeners.add(onTick)
  const current = entry
  return () => {
    current.listeners.delete(onTick)
    if (current.listeners.size > 0 || current.teardown) return
    current.teardown = setTimeout(() => {
      current.teardown = null
      if (current.listeners.size > 0 || shared.get(topic) !== current) return
      shared.delete(topic)
      void current.client.removeChannel(current.channel)
    }, TEARDOWN_DELAY_MS)
  }
}
