'use client'

/**
 * Demo-mode chrome: the persistent chip that keeps a demo session honest, and
 * the menu control that enters/exits the mode.
 *
 * The chip is visible by DEFAULT — nobody works for an hour believing their
 * edits are saving — with a hide-for-capture control that suppresses it for
 * 60 seconds and then restores it, so it never has to be cropped out of a
 * shot. Enter/exit both hard-navigate afterwards: every cached grid must
 * repaint from the other tenant, and a soft refresh would leave stale
 * real-workspace data on a demo screen (or vice versa).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { EyeOff, Loader2, Presentation } from 'lucide-react'
import { useCachedJson } from '@/lib/client/use-cached-json'

const HIDE_MS = 60_000

export function useDemoStatus() {
  const { data, loading } = useCachedJson<{ active?: boolean }>('/api/demo/status')
  return { active: Boolean(data?.active), loading }
}

async function post(path: string): Promise<boolean> {
  try {
    const response = await fetch(path, { method: 'POST' })
    return response.ok
  } catch {
    return false
  }
}

/** Sidebar chip: present whenever the session is inside the demo sandbox. */
export function DemoChip() {
  const { active } = useDemoStatus()
  const [hidden, setHidden] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const hideForCapture = useCallback(() => {
    setHidden(true)
    timer.current = setTimeout(() => setHidden(false), HIDE_MS)
  }, [])
  if (!active || hidden) return null
  return (
    <div
      aria-live="polite"
      className="mx-2 mb-1 flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
    >
      <Presentation aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate">Demo — edits aren&apos;t saved</span>
      <button
        type="button"
        className="rounded p-0.5 text-amber-700 hover:bg-amber-100"
        onClick={hideForCapture}
        aria-label="Hide the demo badge for 60 seconds while capturing"
        title="Hide for capture (60s)"
      >
        <EyeOff className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/** User-menu row: enter or exit demo mode, with the entering wait state. */
export function DemoModeMenuItem() {
  const { active } = useDemoStatus()
  const [busy, setBusy] = useState(false)
  const toggle = useCallback(async () => {
    setBusy(true)
    const ok = await post(active ? '/api/demo/exit' : '/api/demo/enter')
    // Hard navigation on purpose — see the module comment.
    if (ok) window.location.assign('/dashboard')
    else setBusy(false)
  }, [active])
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-graphite-700 hover:bg-graphite-100 disabled:opacity-50"
      disabled={busy}
      onClick={toggle}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Presentation className="h-3.5 w-3.5" />}
      {busy ? 'Setting up your demo workspace…' : active ? 'Exit demo mode' : 'Enter demo mode'}
    </button>
  )
}
