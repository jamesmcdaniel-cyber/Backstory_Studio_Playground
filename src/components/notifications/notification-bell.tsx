'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { AlertCircle, Bell, CheckCircle2, HelpCircle, Info, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSnapshot } from '@/lib/client/snapshot'
import { notificationHref } from '@/lib/notifications/href'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { useProposals } from '@/components/providers/proposals-provider'
import { KIND_LABEL } from '@/components/onboarding/proposal-shared'
import { cn } from '@/lib/utils'

type NotificationItem = {
  id: string
  type: string
  level: 'info' | 'success' | 'error' | 'action'
  title: string
  body?: string | null
  executionId?: string | null
  link?: string | null
  readAt?: string | null
  createdAt: string
}

type PushState = 'unknown' | 'unavailable' | 'available' | 'enabled'

function levelIcon(level: string) {
  switch (level) {
    case 'error': return <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
    case 'success': return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
    case 'action': return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" />
    default: return <Info className="h-4 w-4 shrink-0 text-blue-500" />
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

/** Panel width (Tailwind w-80) and its minimum gutter from the viewport edge. */
const PANEL_WIDTH = 320
const PANEL_GUTTER = 12

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  // Viewport coords for the portaled panel, computed from the bell's rect when
  // opening. The sidebar can't host a dropdown that must escape it: its
  // backdrop-blur + translate classes make it the containing block for ANY
  // fixed/absolute descendant, so an in-place panel gets trapped (and on narrow
  // screens hangs off the right edge — mobile Safari then zooms the whole page
  // out to fit it). Portaling to <body> restores real viewport positioning.
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [pushState, setPushState] = useState<PushState>('unknown')
  // AI recommendations share state with the home surface, so accepting there
  // clears them here too.
  const { proposals, openDetail } = useProposals()
  // The dot counts unread notifications plus pending recommendations.
  const badge = unread + proposals.length

  const load = useCallback(async () => {
    // Shared app-shell snapshot (deduped with the dashboard + sidebar) rather
    // than a dedicated notifications request each tick.
    try {
      const snapshot = await getSnapshot()
      setItems((snapshot.notifications || []) as NotificationItem[])
      setUnread(snapshot.unread || 0)
    } catch {
      // leave the last-known list on a transient failure
    }
  }, [])

  useEffect(() => {
    load().catch(() => {})
    // Poll only while the tab is visible; refresh on return to the tab.
    const timer = window.setInterval(() => {
      if (!document.hidden) load().catch(() => {})
    }, 15000)
    const onVisible = () => {
      if (!document.hidden) load().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  useEffect(() => {
    const probe = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushState('unavailable')
      const res = await fetch('/api/push/key', { cache: 'no-store' }).catch(() => null)
      const data = res && res.ok ? await res.json() : null
      if (!data?.enabled || !data?.publicKey) return setPushState('unavailable')
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = reg ? await reg.pushManager.getSubscription() : null
      setPushState(sub ? 'enabled' : 'available')
    }
    probe().catch(() => setPushState('unavailable'))
  }, [])

  const markRead = async () => {
    if (!unread) return
    setUnread(0)
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })))
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {})
  }

  const enablePush = async () => {
    try {
      const { publicKey } = await (await fetch('/api/push/key', { cache: 'no-store' })).json()
      if (!publicKey) return
      const reg = await navigator.serviceWorker.register('/sw.js')
      if ((await Notification.requestPermission()) !== 'granted') return
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      })
      setPushState('enabled')
    } catch {
      /* ignore — in-app notifications still work */
    }
  }

  const toggleOpen = () => {
    if (open) {
      setOpen(false)
      return
    }
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (anchor) {
      const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_GUTTER * 2)
      setPanelPos({
        top: anchor.bottom + 4,
        // Open rightward from the bell, but never past the viewport edge.
        left: Math.max(PANEL_GUTTER, Math.min(anchor.left, window.innerWidth - width - PANEL_GUTTER)),
        width,
      })
    }
    setOpen(true)
    markRead()
  }

  useDismissOnOutsidePointer(open, () => setOpen(false), [panelRef, anchorRef])

  // A resized window invalidates the coords captured on open; close rather than
  // leave the panel floating away from the bell.
  useEffect(() => {
    if (!open) return
    const onResize = () => setOpen(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  return (
    <div className="relative" ref={anchorRef}>
      <Button
        variant="outline"
        size="icon"
        // overflow-visible: the Button base clips with overflow-hidden, which
        // would cut off the unread badge sitting outside the button bounds.
        className="relative h-9 w-9 shrink-0 overflow-visible"
        aria-label="Notifications"
        onClick={toggleOpen}
      >
        <Bell className="h-4 w-4" />
        {badge > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium text-white">
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </Button>
      {open && panelPos && createPortal(
        /* Portaled to <body>: inside the sidebar, its backdrop-filter +
           transform made ANY fixed descendant position against the sidebar box
           instead of the viewport — the panel got trapped there (hanging off
           narrow screens, where mobile Safari zooms the page out to fit it). */
        <div
          ref={panelRef}
          className="fixed z-[60] rounded-lg border bg-white shadow-lg"
          style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}
        >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-semibold">Notifications</span>
              {pushState === 'available' && <button className="text-xs font-medium text-indigo-600" onClick={enablePush}>Enable push</button>}
              {pushState === 'enabled' && <span className="text-xs text-gray-400">Push on</span>}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {proposals.length > 0 && (
                <div className="border-b bg-indigo-50/30">
                  <div className="flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-indigo-700">
                    <Sparkles className="h-3.5 w-3.5" /> Recommended for you
                  </div>
                  {proposals.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { openDetail(p); setOpen(false) }}
                      className="flex w-full gap-2 border-t border-indigo-100/60 px-3 py-2.5 text-left hover:bg-indigo-50/60"
                    >
                      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.title}</div>
                        <div className="text-xs text-gray-500">{KIND_LABEL[p.kind] ?? 'Suggestion'}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {items.length === 0 && proposals.length === 0 && <p className="px-3 py-6 text-center text-sm text-gray-400">No notifications yet.</p>}
              {items.map((n) => (
                <Link
                  key={n.id}
                  href={notificationHref(n)}
                  onClick={() => setOpen(false)}
                  className={cn('flex gap-2 border-b px-3 py-2.5 hover:bg-gray-50', !n.readAt && 'bg-indigo-50/40')}
                >
                  {levelIcon(n.level)}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="line-clamp-2 text-xs text-gray-500">{n.body}</div>}
                    <div className="mt-0.5 text-[11px] text-gray-400">{new Date(n.createdAt).toLocaleString()}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>,
        document.body,
      )}
    </div>
  )
}
