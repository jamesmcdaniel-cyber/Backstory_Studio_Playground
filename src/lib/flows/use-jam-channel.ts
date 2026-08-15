'use client'

import { useEffect, useRef, useState } from 'react'
import { nextJamStatus, retryDelayMs, type JamStatus } from '@/lib/flows/flow-channels'

/** The slice of a Supabase Realtime channel a jam actually uses. Narrowing it
 *  here is what lets tests drive the hooks with an in-memory double. */
export type JamChannel = {
  on: (type: string, filter: { event: string }, handler: (payload: { payload?: Record<string, unknown>; key?: string }) => void) => JamChannel
  subscribe: (callback?: (status: string, error?: Error) => void) => JamChannel
  send: (message: { type: string; event: string; payload: Record<string, unknown> }) => unknown
  track: (payload: Record<string, unknown>) => unknown
  untrack: () => unknown
  presenceState: <T>() => Record<string, T[]>
}

export type JamClient = {
  channel: (topic: string, options?: unknown) => JamChannel
  removeChannel: (channel: JamChannel) => unknown
  realtime?: { setAuth: (token?: string) => unknown }
}

/** Reported once per failed subscribe so a broken jam leaves a trail instead of
 *  failing silently, which is how the whole feature could look "just broken". */
function reportChannelIssue(topic: string, status: string) {
  if (typeof console !== 'undefined') console.warn(`[jam] ${topic} → ${status}`)
  void import('@sentry/nextjs')
    .then((Sentry) => Sentry.addBreadcrumb({ category: 'jam', level: 'warning', message: `${topic} → ${status}` }))
    .catch(() => undefined)
}

/**
 * Owns one PRIVATE realtime channel's lifecycle: bind → authenticate →
 * subscribe → retry with capped backoff → tear down, reporting a status the UI
 * can show.
 *
 * Private means Postgres authorizes the join (RLS on realtime.messages), so the
 * socket must carry the user's JWT — hence setAuth before every subscribe. A
 * refused join FAILS CLOSED: there is deliberately no fallback to a public
 * channel, because a security control that silently downgrades is worse than an
 * outage you can see.
 */
export function useJamChannel(options: {
  client: JamClient | null
  topic: string
  enabled: boolean
  presenceKey: string
  channelRef: React.MutableRefObject<JamChannel | null>
  /** Registers every binding. Runs once per channel, BEFORE subscribe —
   *  Supabase fixes bindings at join time. */
  bind: (channel: JamChannel) => void
  onSubscribed?: () => void
}): JamStatus {
  const { client, topic, enabled, presenceKey, channelRef } = options
  const [status, setStatus] = useState<JamStatus>('connecting')
  const bindRef = useRef(options.bind)
  bindRef.current = options.bind
  const onSubscribedRef = useRef(options.onSubscribed)
  onSubscribedRef.current = options.onSubscribed

  useEffect(() => {
    if (!enabled || !client) return
    let cancelled = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let channel: JamChannel | null = null

    const teardown = () => {
      const old = channel
      channel = null
      if (!old) return
      if (channelRef.current === old) channelRef.current = null
      try { void Promise.resolve(old.untrack()).catch(() => undefined) } catch { /* already gone */ }
      try { client.removeChannel(old) } catch { /* already gone */ }
    }

    const scheduleRetry = () => {
      if (cancelled || retryTimer) return
      retryTimer = setTimeout(() => {
        retryTimer = null
        join()
      }, retryDelayMs(attempt++))
    }

    const join = () => {
      if (cancelled) return
      // Every attempt gets a FRESH channel: realtime-js allows exactly one
      // subscribe() per instance, and a server-closed channel is removed from
      // the socket for good — re-subscribing the dead instance throws and the
      // jam would stay down until a full page reload.
      teardown()
      let next: JamChannel
      try {
        next = client.channel(topic, { config: { private: true, presence: { key: presenceKey } } })
      } catch {
        setStatus('error') // Supabase not configured — the jam is simply unavailable.
        return
      }
      channel = next
      channelRef.current = next
      bindRef.current(next)
      // setAuth attaches the current JWT; without it a private channel is
      // refused outright.
      void Promise.resolve(client.realtime?.setAuth?.())
        .catch(() => undefined)
        .then(() => {
          if (cancelled || channel !== next) return
          try {
            next.subscribe((subscribeStatus) => {
              if (cancelled || channel !== next) return
              setStatus((current) => nextJamStatus(current, subscribeStatus))
              if (subscribeStatus === 'SUBSCRIBED') {
                attempt = 0
                onSubscribedRef.current?.()
                return
              }
              if (subscribeStatus === 'CHANNEL_ERROR' || subscribeStatus === 'TIMED_OUT' || subscribeStatus === 'CLOSED') {
                reportChannelIssue(topic, subscribeStatus)
                scheduleRetry()
              }
            })
          } catch {
            // subscribe() itself threw (library state guard). Count it as a
            // failed attempt rather than letting it escape as an unhandled
            // rejection that kills the retry loop.
            reportChannelIssue(topic, 'SUBSCRIBE_THREW')
            scheduleRetry()
          }
        })
    }
    join()

    // Waking from laptop sleep or regaining network is when channels are most
    // likely dead AND the user is looking: if a retry is pending, fire it now
    // with the backoff reset instead of making them wait out up to 30s.
    const kick = () => {
      if (cancelled || !retryTimer) return
      clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
      join()
    }
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') kick()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      teardown()
    }
  }, [client, topic, enabled, presenceKey, channelRef])

  return status
}
