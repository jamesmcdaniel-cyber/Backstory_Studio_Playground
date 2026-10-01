'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Loader2 } from 'lucide-react'
import { buildProcessTimeline, feedLabel, type ProcessEvent, type ProcessToolStep } from '@/lib/agents/process-feed'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import { useAgentExecStream } from './use-agent-exec-stream'

type ExecutionDetail = {
  execution: { id: string; status: string; startedAt?: string | null }
  steps: ProcessToolStep[]
  events: ProcessEvent[]
}

/**
 * The run, narrated live, on the page that started it — the same feed the
 * Runs panel shows, so starting an analysis never means a closed panel and a
 * toast. Ticks come over the execution's realtime channel; a slow poll
 * covers deployments without one.
 */
export function RunFeed({ executionId, status, onStatusChange, compact = false }: { executionId: string; status: string; onStatusChange?: (status: string) => void; compact?: boolean }) {
  const [detail, setDetail] = useState<ExecutionDetail | null>(null)
  const live = !isTerminalRunStatus(status)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/workflows/executions?executionId=${encodeURIComponent(executionId)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { items?: ExecutionDetail[] }
      const item = data.items?.[0]
      if (item) {
        setDetail(item)
        if (item.execution.status !== status) onStatusChange?.(item.execution.status)
      }
    } catch {
      // A missed refresh is covered by the next tick or poll.
    }
  }, [executionId, status, onStatusChange])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => (live ? startVisibleInterval(() => void refresh(), 8_000) : undefined), [live, refresh])
  useAgentExecStream(executionId, () => void refresh(), live)

  const items = detail ? buildProcessTimeline(detail.events, detail.steps).items : []
  const rows = items.slice(-12)
  const latest = rows[rows.length - 1]

  return (
    <div className={`min-w-0 rounded-xl border border-border bg-muted/30 ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {live && <Loader2 className="h-4 w-4 animate-spin text-horizon-600" aria-hidden />}
          {live ? 'The agent is working' : 'Run finished'}
        </div>
        <Link href={`/agents?run=${executionId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          Open in Runs <ExternalLink className="h-3 w-3" aria-hidden />
        </Link>
      </div>
      {live && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><TypewriterStatus />{latest && <span className="min-w-0 break-words">· {feedLabel(latest)}</span>}</div>}
      {rows.length > 0 && (
        <ol className={`mt-3 space-y-1.5 border-l border-border pl-3 text-xs text-muted-foreground ${compact ? 'max-h-56 overflow-y-auto break-words pr-1' : ''}`} aria-live="polite">
          {rows.map((item) => (
            <li key={item.key} className="relative">
              <span className="absolute -left-[15px] top-1.5 h-1.5 w-1.5 rounded-full bg-horizon-400" aria-hidden />
              {feedLabel(item)}
            </li>
          ))}
        </ol>
      )}
      {!rows.length && live && <p className="mt-2 text-xs text-muted-foreground">Queued — the worker picks it up in a moment.</p>}
    </div>
  )
}
