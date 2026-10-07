'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relative-time'
import { PageSetupCard } from '@/components/roi/page-setup-card'
import { RunHistory } from '@/components/roi/run-history'
import { SettingsForm } from '@/components/roi/settings-form'
import type { ReportFilters } from '@/components/roi/report-frame'
import type { RoiAnalysisView, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

const OTHER_ACCOUNT = '__other__'
const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const FILTER_GROUPS: Array<{ key: keyof ReportFilters; label: string }> = [
  { key: 'fy', label: 'Fiscal year' },
  { key: 'fq', label: 'Quarter' },
  { key: 'role', label: 'Role' },
]

function accountLine(account: RoiPageAccount, setup: RoiPageSetup): string {
  const parts: string[] = []
  if (account.report) parts.push(`Report updated ${relativeTime(account.report.updatedAt)}`)
  if (account.covers.length) parts.push(`data covers ${account.covers.join(', ')}${account.loadedAt ? `, loaded ${relativeTime(account.loadedAt)}` : ''}`)
  else if (setup.dataSource.kind === 'flow') parts.push(`data fetched by the ${setup.dataSource.flowName ?? 'data'} flow`)
  else if (!account.report) parts.push('no data loaded yet')
  const line = parts.join(' · ')
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/**
 * The ROI page's side panel, opened from its menu button: everything that
 * shapes the report on screen. Which account; the report's filters (fiscal
 * year, quarter, role — applied live); the analysis settings (applied as the
 * report's next version); run history; and what powers the page.
 */
export function SettingsPanel({ open, onClose, setup, account, onAccountChange, filters, filterOptions, onFiltersChange, analyses, historyError, onStarted, onOpenRun, onDataSourceChange, busy }: {
  open: boolean
  onClose: () => void
  setup: RoiPageSetup
  account: RoiPageAccount | null
  onAccountChange: (account: string) => void
  filters: ReportFilters
  filterOptions: ReportFilters | null
  onFiltersChange: (filters: ReportFilters) => void
  analyses: RoiAnalysisView[] | null
  historyError: string | null
  onStarted: (analysis: RoiAnalysisView) => void
  onOpenRun: (run: RoiAnalysisView) => void
  onDataSourceChange: (dataSource: RoiPageSetup['dataSource']) => void
  busy: boolean
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const canType = setup.dataSource.kind === 'flow'
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); returnFocus.current?.focus?.() }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null
  const toggle = (key: keyof ReportFilters, value: string) => {
    const current = filters[key]
    onFiltersChange({ ...filters, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] })
  }
  const anyFilter = filters.fy.length + filters.fq.length + filters.role.length > 0
  const groups = FILTER_GROUPS.filter((group) => (filterOptions?.[group.key] ?? []).length > 0)

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-graphite-950/30" aria-hidden onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="roi-panel-title" className="absolute inset-y-0 left-0 flex w-[min(420px,92vw)] flex-col border-r bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-wider text-horizon-700">ROI analysis</p>
            <h2 id="roi-panel-title" className="text-lg font-semibold tracking-tight">Filters and settings</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <section aria-labelledby="roi-account-heading" className="space-y-1.5">
            <h3 id="roi-account-heading" className="text-sm font-semibold">Account</h3>
            {setup.accounts.length > 0 && (
              <select
                aria-labelledby="roi-account-heading"
                value={typing ? OTHER_ACCOUNT : account?.account ?? ''}
                onChange={(event) => {
                  if (event.target.value === OTHER_ACCOUNT) { setTyping(true); return }
                  setTyping(false)
                  onAccountChange(event.target.value)
                }}
                className={SELECT_CLASS}
              >
                {setup.accounts.map((option) => <option key={option.account} value={option.account}>{option.account}{option.report ? '' : ' (no report yet)'}</option>)}
                {canType && <option value={OTHER_ACCOUNT}>Another account…</option>}
              </select>
            )}
            {(typing || (!setup.accounts.length && canType)) && (
              <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (typed.trim()) { setTyping(false); onAccountChange(typed.trim()) } }}>
                <input aria-label="Account name" value={typed} onChange={(event) => setTyped(event.target.value)} maxLength={200} placeholder="The customer account, as Backstory names it" className={SELECT_CLASS} />
                <button type="submit" className="shrink-0 rounded-md border px-3 text-sm font-medium hover:bg-muted">Use</button>
              </form>
            )}
            {account && <p className="text-xs text-muted-foreground">{accountLine(account, setup)}</p>}
            {!setup.accounts.length && !canType && (
              <p className="text-sm text-muted-foreground">No account has data loaded yet. An operator loads an account's extracts into the Repository, or the analyst's owner connects the data flow below.</p>
            )}
          </section>

          {account?.report && groups.length > 0 && (
            <section aria-labelledby="roi-filters-heading" className="space-y-3">
              <div className="flex items-baseline justify-between gap-2">
                <h3 id="roi-filters-heading" className="text-sm font-semibold">Report filters</h3>
                {anyFilter && <button type="button" onClick={() => onFiltersChange({ fy: [], fq: [], role: [] })} className="text-xs font-medium text-horizon-700 hover:underline">Clear</button>}
              </div>
              <p className="text-xs text-muted-foreground">Applied to the report as you choose them. Fiscal year and quarter slice the deal and stage views; role narrows the reps behind the activity and adoption views.</p>
              {groups.map((group) => (
                <div key={group.key} role="group" aria-label={group.label}>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">{group.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(filterOptions?.[group.key] ?? []).map((value) => {
                      const on = filters[group.key].includes(value)
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggle(group.key, value)}
                          className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-horizon-600 bg-horizon-600 text-white' : 'border-border bg-background hover:bg-muted')}
                        >
                          {value}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </section>
          )}

          {account && (
            <section className="border-t pt-6">
              <SettingsForm key={`${account.account}:${account.report?.updatedAt ?? 'new'}`} setup={setup} account={account} onStarted={onStarted} busy={busy} />
            </section>
          )}

          <section className="border-t pt-6">
            <RunHistory analyses={analyses} error={historyError} onOpenRun={onOpenRun} compact />
          </section>

          <section className="border-t pt-6">
            <PageSetupCard setup={setup} onDataSourceChange={onDataSourceChange} />
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
