'use client'

import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One collapsible section of the ROI page's side panel: a disclosure button
 * (chevron, title, an optional count and flag) with a one-line summary while
 * it is closed, and actions that sit beside the button rather than inside it.
 * The body stays mounted while closed (hidden), so what it holds — chosen
 * files, a search, a draft — survives a collapse.
 */
export function PanelSection({ id, title, summary, count, countLabel, flag, flagTone = 'info', open, onOpenChange, actions, children }: {
  /** Prefix for the button and body ids. */
  id: string
  title: string
  /** One line shown under the title while the section is closed. */
  summary?: string | null
  /** A count badge (active filters); nothing is shown for 0. */
  count?: number
  /** What the count counts, for screen readers: "active filters". */
  countLabel?: string
  /** A short status beside the title: "Changed", "Required". */
  flag?: string | null
  flagTone?: 'info' | 'risk'
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Small controls beside the header (a Clear button), reachable while closed. */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const buttonId = `${id}-button`
  const bodyId = `${id}-body`
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-start transition-colors duration-fast hover:bg-muted/40">
        <h3 className="min-w-0 flex-1">
          <button
            id={buttonId}
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => onOpenChange(!open)}
            className="flex w-full items-start gap-2 px-5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast', open && 'rotate-90')} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{title}</span>
                {count ? (
                  <span className="rounded-full bg-horizon-600 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-white">
                    {count}{countLabel && <span className="sr-only"> {countLabel}</span>}
                  </span>
                ) : null}
                {flag && (
                  <span className={cn('rounded-full px-1.5 text-[10px] font-medium leading-4 ring-1 ring-inset', flagTone === 'risk' ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-horizon-50 text-horizon-700 ring-horizon-200')}>
                    {flag}
                  </span>
                )}
              </span>
              {!open && summary && (
                <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground" title={summary}>{summary}</span>
              )}
            </span>
          </button>
        </h3>
        {actions && <div className="flex shrink-0 items-center gap-1 py-2.5 pr-4">{actions}</div>}
      </div>
      {/* No display utilities here: they would override `hidden`. */}
      <div id={bodyId} hidden={!open} className="px-5 pb-5 pt-0.5">
        {children}
      </div>
    </div>
  )
}

const COLUMNS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4' }

/**
 * A row of mutually exclusive choices on one line. Native radios underneath
 * (arrow keys move the choice; Tab enters at the chosen one), labelled by a
 * visible heading (`labelledBy`) or `label`.
 */
export function SegmentedControl<T extends string | number>({ name, label, labelledBy, describedBy, value, options, onChange, disabled = false }: {
  /** The radio group's name: unique on the page. */
  name: string
  label?: string
  labelledBy?: string
  describedBy?: string
  value: T
  options: Array<{
    value: T
    label: string
    /** Read after the visible label: " — last 6 months, recommended". */
    srLabel?: string
    title?: string
  }>
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn('grid gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5', COLUMNS[options.length] ?? 'grid-flow-col auto-cols-fr')}
    >
      {options.map((option) => {
        const checked = option.value === value
        const id = `${name}-${String(option.value)}`
        return (
          <label
            key={String(option.value)}
            htmlFor={id}
            title={option.title}
            className={cn(
              'flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-md px-2 text-xs font-medium transition-colors duration-fast has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              checked ? 'bg-background text-horizon-700 shadow-1' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={String(option.value)}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            <span className="truncate">{option.label}</span>
            {option.srLabel && <span className="sr-only">{option.srLabel}</span>}
          </label>
        )
      })}
    </div>
  )
}
