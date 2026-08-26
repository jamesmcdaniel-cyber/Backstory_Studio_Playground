'use client'

import type { ReactNode } from 'react'
import { Info, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Guidance inside a step's parameters — n8n's `notice` parameter type.
 *
 * Theirs is a declared parameter, so every notice in every node looks the same
 * and sits in the parameter list rather than beside it. Ours were five ad-hoc
 * callouts in three different visual treatments: amber body text under one
 * field, a bordered indigo card somewhere else, a bare paragraph in a third.
 * Same job, three appearances, and nothing to reach for when the next one is
 * needed.
 *
 * Two tones, because a panel only ever says two things: here is something worth
 * knowing, and here is something that will bite you.
 */
export function PanelNotice({
  tone = 'info',
  children,
  action,
  className,
}: {
  tone?: 'info' | 'warning'
  children: ReactNode
  /** An affordance that resolves what the notice is about. */
  action?: ReactNode
  className?: string
}) {
  const Icon = tone === 'warning' ? AlertTriangle : Info
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-xs leading-5',
        tone === 'warning'
          ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          : 'border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-200',
        className,
      )}
      data-panel-notice={tone}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div>{children}</div>
        {action}
      </div>
    </div>
  )
}
