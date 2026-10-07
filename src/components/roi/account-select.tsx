'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AccountOption = {
  value: string
  label: string
  /** One quiet line under the name: whether it has a report, how fresh. */
  hint?: string
  /** Has a report to show. */
  ready?: boolean
}

/**
 * The ROI page's account picker: a field that opens a list BELOW it. The
 * browser's own select opens over the field on macOS, in its own style; this
 * one keeps the panel's look. A select-only combobox: arrow keys move, Enter
 * or Space picks, Home and End jump, Escape closes the list (not the panel),
 * Tab moves on. Picking "Another account…" hands over to the typed entry.
 */
export function AccountSelect({ id, value, options, onSelect, onOther, placeholder = 'Choose an account' }: {
  id: string
  value: string | null
  options: AccountOption[]
  onSelect: (value: string) => void
  /** Offered when any account can be typed (a data flow fetches its data). */
  onOther?: () => void
  placeholder?: string
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const items: Array<AccountOption & { other?: boolean }> = [...options, ...(onOther ? [{ value: '__other__', label: 'Another account…', hint: 'Type any account the data flow can fetch', other: true }] : [])]
  const selectedIndex = items.findIndex((item) => !item.other && item.value === value)
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  const openAt = (index: number) => { setActive(Math.max(0, Math.min(items.length - 1, index))); setOpen(true) }
  const choose = (index: number) => {
    const item = items[index]
    if (!item) return
    setOpen(false)
    buttonRef.current?.focus()
    if (item.other) onOther?.()
    else if (item.value !== value) onSelect(item.value)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault()
        openAt(selectedIndex >= 0 ? selectedIndex : 0)
      }
      return
    }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => Math.min(items.length - 1, i + 1)) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => Math.max(0, i - 1)) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(items.length - 1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active) }
    else if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openAt(selectedIndex >= 0 ? selectedIndex : 0))}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-11 w-full items-center gap-3 rounded-lg border bg-background px-3.5 text-left shadow-sm transition-[border-color,box-shadow] duration-fast',
          'hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open ? 'border-horizon-500 ring-2 ring-horizon-500/20' : 'border-input',
        )}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', selected?.ready ? 'bg-horizon-600' : 'bg-graphite-300')} aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate text-sm', selected ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={id}
          tabIndex={-1}
          className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-72 overflow-y-auto rounded-xl border bg-background p-1.5 shadow-lg ring-1 ring-black/5"
        >
          {items.map((item, index) => {
            const isSelected = index === selectedIndex
            return (
              <li
                key={item.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                onKeyDown={onKeyDown}
                className={cn(
                  'flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2',
                  index === active ? 'bg-muted' : 'bg-transparent',
                  item.other && 'mt-1 border-t border-border pt-2.5',
                )}
              >
                {item.other
                  ? <Plus className="mt-0.5 h-4 w-4 shrink-0 text-horizon-700" aria-hidden />
                  : <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.ready ? 'bg-horizon-600' : 'bg-graphite-300')} aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-sm', isSelected ? 'font-semibold text-foreground' : 'font-medium text-foreground', item.other && 'text-horizon-800')}>{item.label}</span>
                  {item.hint && <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>}
                </span>
                {isSelected && <Check className="mt-0.5 h-4 w-4 shrink-0 text-horizon-700" aria-hidden />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
