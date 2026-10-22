'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, ChevronDown, ExternalLink, Hand, Loader2, RotateCcw, Undo2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { cn } from '@/lib/utils'
import type { AgentActionView } from '@/lib/agents/action-ledger-types'

/**
 * "What this agent did" — the action ledger, for one agent, flow or run.
 *
 * Every side-effecting call is listed with what it touched, as whom, and how
 * it went; a write whose provider can reverse it offers Undo, and one that
 * can't says why. The undo verdict comes from the server for the person
 * viewing (only a personal connection's owner can undo through it).
 */

type Filter = { agentId: string } | { flowId: string } | { runId: string }

function query(filter: Filter, cursor?: string | null) {
  const params = new URLSearchParams(filter as Record<string, string>)
  if (cursor) params.set('cursor', cursor)
  return `/api/agent-actions?${params.toString()}`
}

/** The thing a call acted on, in a word or two: "#revenue", "Task", "a@b.co". */
function targetOf(entry: AgentActionView): string | null {
  const ref = entry.resultRef ?? {}
  const args = entry.argsSummary ?? {}
  const pick = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  return pick(ref.label) ?? pick(args.channel) ?? pick(args.to) ?? pick(args.sobject) ?? pick(args.summary) ?? pick(args.title) ?? pick(args.filename) ?? null
}

function when(iso: string) {
  const date = new Date(iso)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function StatusMark({ status }: { status: AgentActionView['status'] }) {
  if (status === 'done') return <Check className="h-4 w-4 text-[var(--status-good-fg)]" aria-label="Done" />
  if (status === 'failed') return <XCircle className="h-4 w-4 text-[var(--status-risk-fg)]" aria-label="Failed" />
  if (status === 'undone') return <Undo2 className="h-4 w-4 text-fg-muted" aria-label="Undone" />
  return <Loader2 className="h-4 w-4 animate-spin text-fg-muted" aria-label="Undoing" />
}

function ArgsList({ args }: { args: Record<string, unknown> }) {
  const entries = Object.entries(args)
  if (!entries.length) return null
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-medium text-gray-600">{key}</dt>
          <dd className="min-w-0 break-words text-fg-muted">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function LedgerRow({ entry, onUndo }: { entry: AgentActionView; onUndo: (entry: AgentActionView) => void }) {
  const [open, setOpen] = useState(false)
  const target = targetOf(entry)
  const url = typeof entry.resultRef?.url === 'string' ? entry.resultRef.url : null
  return (
    <li className={cn('px-3 py-2.5', entry.status === 'undone' && 'bg-gray-50/70')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0"><StatusMark status={entry.status} /></span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        >
          <span className={cn('flex items-center gap-1.5 text-sm text-foreground', entry.status === 'undone' && 'text-muted-foreground line-through decoration-gray-300')}>
            <span className="truncate font-medium">{entry.toolLabel}</span>
            {target && <span className="truncate text-muted-foreground">{target}</span>}
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200', open && 'rotate-180')} aria-hidden="true" />
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            {when(entry.createdAt)}
            {entry.actor ? `, as ${entry.actor.name}${entry.actsAs === 'workspace' ? ' through a workspace connection' : ''}` : ''}
            {entry.approvedBy ? `, approved by ${entry.approvedBy.name}` : ''}
            {entry.status === 'undone' && entry.undoneBy ? `. Undone by ${entry.undoneBy.name}` : ''}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex h-8 w-8 items-center justify-center rounded text-fg-muted transition-colors duration-150 hover:bg-gray-100 hover:text-gray-700"
              aria-label={`Open what ${entry.toolLabel} created`}
              title="Open"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {entry.status === 'done' && entry.undo.possible && entry.undo.allowed && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => onUndo(entry)}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Undo
            </Button>
          )}
        </span>
      </div>
      {open && (
        <div className="ml-7 mt-2 space-y-2 rounded-lg border border-gray-200/80 bg-white p-3">
          {entry.error && <p className="text-xs text-[var(--status-risk-fg)]">{entry.error}</p>}
          <ArgsList args={entry.argsSummary} />
          <p className="flex items-start gap-1.5 text-xs text-fg-muted">
            {entry.status === 'done' && entry.undo.possible ? (
              entry.undo.allowed
                ? <><RotateCcw className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> Undo: {entry.undo.effect}</>
                : <><Hand className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" /> {entry.undo.reason}</>
            ) : entry.status === 'done' || entry.status === 'failed' ? (
              <>Can&apos;t be undone{entry.undo.reason ? `: ${entry.undo.reason}` : '.'}</>
            ) : null}
          </p>
          {entry.undoError && entry.status === 'done' && <p className="text-xs text-[var(--status-warn-fg)]">Last undo attempt failed: {entry.undoError}</p>}
        </div>
      )}
    </li>
  )
}

/**
 * The ledger list. `compact` drops the heading copy for use inside a run's
 * detail; an empty compact ledger renders nothing (a run that changed nothing
 * needs no section saying so).
 */
export function ActionLedger({ filter, compact = false, className }: { filter: Filter; compact?: boolean; className?: string }) {
  const [items, setItems] = useState<AgentActionView[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<AgentActionView | null>(null)
  const [busy, setBusy] = useState(false)
  const key = JSON.stringify(filter)

  const load = useCallback(async (next?: string | null) => {
    try {
      const response = await fetch(query(JSON.parse(key) as Filter, next), { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error || 'Could not load what this agent did.')
        return
      }
      setError(null)
      setItems((current) => (next ? [...(current ?? []), ...data.items] : data.items))
      setCursor(data.nextCursor ?? null)
    } catch {
      setError('Could not load what this agent did.')
    }
  }, [key])

  useEffect(() => {
    setItems(null)
    void load()
  }, [load])

  const undo = async () => {
    if (!confirming) return
    setBusy(true)
    try {
      const response = await fetch(`/api/agent-actions/${confirming.id}/undo`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) {
        toast.error(data.error || 'The undo didn’t go through.')
        return
      }
      toast.success(data.alreadyGone ? 'Already gone — marked as undone.' : 'Undone.')
      setConfirming(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className={cn('text-sm text-muted-foreground', className)}>{error}</p>
  if (!items) {
    return compact ? null : (
      <p className={cn('flex items-center gap-2 p-4 text-sm text-muted-foreground', className)}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading what this agent did…
      </p>
    )
  }
  if (!items.length && compact) return null

  return (
    <section className={cn('space-y-2', className)}>
      {compact ? (
        <h4 className="eyebrow flex items-center gap-2">
          <Undo2 className="h-4 w-4" aria-hidden="true" /> Changes made <span className="text-fg-muted">{items.length}</span>
        </h4>
      ) : (
        <div>
          <h3 className="text-base font-semibold text-foreground">What this agent did</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every message, record and change it made outside Backstory, newest first. Undo reverses one where the app allows it.
          </p>
        </div>
      )}
      {items.length ? (
        <ul className="divide-y rounded-xl border border-gray-200/80 bg-white">
          {items.map((entry) => <LedgerRow key={entry.id} entry={entry} onUndo={setConfirming} />)}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          Nothing yet. When this agent sends, creates or changes something, it shows up here.
        </p>
      )}
      {cursor && (
        <div className="flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => load(cursor)}>Show older</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && !busy && setConfirming(null)}
        title={confirming ? `Undo ${confirming.toolLabel.toLowerCase()}?` : 'Undo?'}
        description={confirming?.undo.effect}
        confirmLabel="Undo"
        destructive
        busy={busy}
        onConfirm={undo}
      />
    </section>
  )
}
