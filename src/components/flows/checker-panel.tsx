'use client'

import { ChevronRight, CheckCircle2, Download, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FlowValidationIssue, FlowValidationResult } from '@/lib/flows/validate'

function IssueRow({ issue, onJump }: { issue: FlowValidationIssue; onJump: (nodeId: string) => void }) {
  const dot = issue.level === 'error' ? 'bg-red-500' : 'bg-amber-500'
  const content = (
    <>
      <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <span className="min-w-0 flex-1 text-sm">{issue.message}</span>
      {issue.nodeId && <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
    </>
  )
  if (!issue.nodeId) {
    return <div className="flex items-start gap-2 px-3 py-2">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={() => onJump(issue.nodeId!)}
      className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
    >
      {content}
    </button>
  )
}

export function CheckerPanel({
  validation,
  onJump,
  onFixWithCopilot,
  fixing,
  canFix = true,
  onDownloadDebug,
  onClose,
}: {
  validation: FlowValidationResult
  onJump: (nodeId: string) => void
  onFixWithCopilot: () => void
  fixing: boolean
  /** Copilot fixes edit the flow — hidden for view-only + external guests. */
  canFix?: boolean
  /** Downloads the flow JSON with these findings embedded, for external debugging. */
  onDownloadDebug?: () => void
  onClose: () => void
}) {
  const hasIssues = validation.errors.length > 0 || validation.warnings.length > 0
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Flow checker</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-border px-4 py-2">
        {hasIssues ? (
          <p className="text-xs text-muted-foreground">
            {validation.errors.length} error{validation.errors.length === 1 ? '' : 's'} · {validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'}
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> All checks pass
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {!hasIssues ? (
          <p className="p-4 text-sm text-muted-foreground">No problems found — this flow is ready to run.</p>
        ) : (
          <>
            {validation.errors.length > 0 && (
              <div>
                <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-red-600">Errors</p>
                {validation.errors.map((issue, i) => (
                  <IssueRow key={`error-${issue.code}-${issue.nodeId ?? 'flow'}-${i}`} issue={issue} onJump={onJump} />
                ))}
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div>
                <p className="px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-amber-600">Warnings</p>
                {validation.warnings.map((issue, i) => (
                  <IssueRow key={`warning-${issue.code}-${issue.nodeId ?? 'flow'}-${i}`} issue={issue} onJump={onJump} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {hasIssues && (canFix || onDownloadDebug) && (
        <div className="space-y-2 border-t border-border p-3">
          {canFix && (
            <Button variant="outline" size="sm" className="w-full" onClick={onFixWithCopilot} loading={fixing} disabled={fixing}>
              <Sparkles className="mr-1.5 h-4 w-4" /> Fix with Copilot
            </Button>
          )}
          {onDownloadDebug && (
            <Button variant="ghost" size="sm" className="w-full" onClick={onDownloadDebug}>
              <Download className="mr-1.5 h-4 w-4" /> Download JSON with findings
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
