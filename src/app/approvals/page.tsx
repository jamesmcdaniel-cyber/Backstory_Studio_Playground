'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Check, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { cn } from '@/lib/utils'

// Where the approval came from, resolved server-side from its executionId
// (which ambiguously holds an AgentExecution id or a FlowRun id).
type ApprovalSource = { kind: 'flow'; flowId: string } | { kind: 'agent'; agentId: string | null } | null

type ApprovalRow = {
  id: string
  tool: string
  summary: string
  status: string
  createdAt: string
  executionId: string
  source: ApprovalSource
}

type Filter = 'pending' | 'decided'

// The list endpoint accepts a comma-separated status set, so "Decided" is one
// fetch over every settled status, returned newest-first and pageable.
const DECIDED_STATUSES = ['approved', 'rejected', 'superseded', 'failed'] as const

const PAGE_SIZE = 50

// Plain-English labels for stored decision statuses — raw values never render.
const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Replaced by a newer request',
  failed: 'Approved, but sending failed',
  approving: 'Being approved',
  pending: 'Waiting for a decision',
}

const STATUS_BADGE: Record<string, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  approved: 'good',
  rejected: 'outline',
  superseded: 'warn',
  failed: 'risk',
  approving: 'info',
  pending: 'warn',
}

/** "5m ago"-style relative time, falling back to the date for older items. */
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString()
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * The stored summary is `tool (capability)` — e.g. `slack_post_message (slack)`.
 * The parenthetical is the only provider hint the row carries; pull it out so
 * the tool name can be humanized against it and the provider shown in English.
 */
function providerFromSummary(summary: string): string | null {
  const match = /\(([^()]+)\)\s*$/.exec(summary)
  if (!match) return null
  return match[1].replace(/^nango:/, '')
}

function providerLabel(provider: string): string {
  const words = provider.split(/[_\-\s]+/).filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Deep link to the run that raised this approval. Flow runs live on the
 * flow's activity page; agent runs are inspected via the dashboard's run
 * pane (`?run=`), the same deep link the notification bell uses — there is
 * no per-agent activity page. Null when the source row no longer exists.
 */
function activityHref(row: ApprovalRow): string | null {
  if (row.source?.kind === 'flow') return `/flows/${row.source.flowId}/activity`
  if (row.source?.kind === 'agent') return `/agents?run=${row.executionId}`
  return null
}

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<Filter>('pending')
  const [rows, setRows] = useState<ApprovalRow[]>([])
  const [loading, setLoading] = useState(true)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [decidingAction, setDecidingAction] = useState<'approve' | 'reject' | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const statusParam = filter === 'pending' ? 'pending' : DECIDED_STATUSES.join(',')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const page = await fetch(`/api/approvals?status=${statusParam}&skip=0&take=${PAGE_SIZE}`, { cache: 'no-store' })
        .then((response) => response.json())
        .catch(() => null)
      if (cancelled) return
      setRows(page?.success ? (page.approvals as ApprovalRow[]) : [])
      setHasMore(Boolean(page?.success && page.hasMore))
      setLoading(false)
    }
    setLoading(true)
    load()
    return () => {
      cancelled = true
    }
  }, [statusParam, refreshKey])

  const loadMore = useCallback(async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      // Offset pagination: rows already shown = the offset. New arrivals can
      // shift the window, so appends are deduped by id.
      const page = await fetch(`/api/approvals?status=${statusParam}&skip=${rows.length}&take=${PAGE_SIZE}`, { cache: 'no-store' })
        .then((response) => response.json())
        .catch(() => null)
      if (!page?.success) {
        toast.error('Could not load more approvals — try again.')
        return
      }
      const incoming = page.approvals as ApprovalRow[]
      setRows((previous) => {
        const seen = new Set(previous.map((row) => row.id))
        return [...previous, ...incoming.filter((row) => !seen.has(row.id))]
      })
      setHasMore(Boolean(page.hasMore))
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, statusParam, rows.length])

  const decide = useCallback(
    async (row: ApprovalRow, approve: boolean) => {
      if (decidingId) return
      setDecidingId(row.id)
      setDecidingAction(approve ? 'approve' : 'reject')
      try {
        const response = await fetch(`/api/approvals/${row.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: approve ? 'approve' : 'reject' }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          toast.error(data.error || 'Could not record your decision — try again.')
          // A failed approve may still have marked the approval (e.g. delivery
          // threw after the claim) — refetch so the row shows its honest state
          // instead of staying pending with live buttons.
          setRefreshKey((key) => key + 1)
          return
        }
        // The API is idempotent and race-safe: a decision that lost the claim
        // (someone else decided first) reports the settled state — surface
        // that honestly instead of pretending our click won.
        if (data.status === 'superseded') {
          toast('This approval was superseded by a newer request.')
        } else if (approve ? data.status !== 'approved' : data.status !== 'rejected') {
          toast('This approval was already decided.')
        } else if (approve) {
          toast.success(data.executed ? 'Approved — the action was sent.' : 'Approved.')
        } else {
          toast.success('Rejected — the action was dropped.')
        }
        // Drop the row immediately, then refetch to pick up the settled state.
        setRows((previous) => previous.filter((candidate) => candidate.id !== row.id))
        setRefreshKey((key) => key + 1)
      } finally {
        setDecidingId(null)
        setDecidingAction(null)
      }
    },
    [decidingId],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approvals"
        description="Actions waiting on your sign-off before they run."
        actions={
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        {(['pending', 'decided'] as const).map((key) => (
          <Button key={key} variant={filter === key ? 'default' : 'outline'} size="sm" onClick={() => setFilter(key)}>
            {key === 'pending' ? 'Pending' : 'Decided'}
          </Button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={filter === 'pending' ? 'Nothing waiting on you.' : 'No decided approvals yet.'}
          description={
            filter === 'pending'
              ? 'When an agent or flow needs your sign-off, it will show up here.'
              : 'Decisions you and your teammates make will show up here.'
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead className="text-right">{filter === 'pending' ? 'Decision' : 'Outcome'}</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Activity</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const provider = providerFromSummary(row.summary)
              const deciding = decidingId === row.id
              const href = activityHref(row)
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="text-sm font-medium">{humanizeToolName(row.tool, provider ?? undefined)}</div>
                    {provider && <div className="text-xs text-muted-foreground">via {providerLabel(provider)}</div>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground" title={new Date(row.createdAt).toLocaleString()}>
                    {relativeTime(row.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.status === 'pending' ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          onClick={() => decide(row, true)}
                          loading={deciding && decidingAction === 'approve'}
                          disabled={decidingId !== null}
                        >
                          {!(deciding && decidingAction === 'approve') && <Check className="mr-1 h-3.5 w-3.5" />}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => decide(row, false)}
                          loading={deciding && decidingAction === 'reject'}
                          disabled={decidingId !== null}
                        >
                          {!(deciding && decidingAction === 'reject') && <X className="mr-1 h-3.5 w-3.5" />}
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <Badge variant={STATUS_BADGE[row.status] || 'outline'}>
                        {STATUS_LABEL[row.status] || 'Decided'}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {href && (
                      <Link
                        href={href}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        View activity
                        <ArrowUpRight className="h-3 w-3" />
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}

      {!loading && rows.length > 0 && hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  )
}
