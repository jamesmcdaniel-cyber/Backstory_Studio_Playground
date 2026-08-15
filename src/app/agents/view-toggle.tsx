'use client'

import { useId } from 'react'
import { motion } from 'motion/react'
import { cn } from '@/lib/utils'
import { SPRING } from '@/lib/motion'

export type DashboardView = 'agents' | 'templates'

/**
 * The Agents / Library segmented toggle at the top of the dashboard. A blue
 * pill slides between the two segments; Library carries a live count badge.
 * Accessible as a tablist; the active pill respects reduced motion (the spring
 * simply resolves instantly under the global MotionConfig).
 */
export function ViewToggle({
  view,
  onChange,
  templateCount,
}: {
  view: DashboardView
  onChange: (view: DashboardView) => void
  templateCount: number | null
}) {
  const layoutId = useId()
  const items: { key: DashboardView; label: string; count: number | null }[] = [
    { key: 'agents', label: 'Agents', count: null },
    { key: 'templates', label: 'Library', count: templateCount },
  ]
  return (
    <div role="tablist" aria-label="Switch view" className="inline-flex items-center gap-1 rounded-2xl border border-border bg-card p-1 shadow-1">
      {items.map((item) => {
        const active = view === item.key
        return (
          <button
            key={item.key}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative inline-flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`${layoutId}-pill`}
                className="absolute inset-0 rounded-xl bg-primary shadow-2"
                transition={SPRING.snappy}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10">{item.label}</span>
            {typeof item.count === 'number' && item.count > 0 && (
              <span
                className={cn(
                  'relative z-10 min-w-5 rounded-full px-1.5 py-0.5 text-center text-xs font-semibold tabular-nums',
                  active ? 'bg-white/25 text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
