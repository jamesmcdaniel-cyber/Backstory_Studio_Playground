'use client'

import { FileWarning, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FlowImportNote } from '@/lib/flows/import/from-n8n'

export type { FlowImportNote }

/** The persisted import report shape (Flow.importNotes). */
export type FlowImportReport = {
  notes: FlowImportNote[]
  /** Blocking validation errors counted right after import. */
  blocking: number
}

/** Parse the wire value defensively — importNotes is plain Json on the flow. */
export function parseImportReport(value: unknown): FlowImportReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { notes?: unknown; blocking?: unknown }
  if (!Array.isArray(record.notes)) return null
  const notes: FlowImportNote[] = record.notes
    .filter((note): note is Record<string, unknown> => Boolean(note && typeof note === 'object'))
    .map((note): FlowImportNote => ({
      code: typeof note.code === 'string' ? note.code : 'IMPORT_NOTE',
      severity: note.severity === 'error' ? 'error' : note.severity === 'info' ? 'info' : 'warning',
      message: typeof note.message === 'string' ? note.message : '',
      ...(typeof note.nodeId === 'string' ? { nodeId: note.nodeId } : {}),
    }))
    .filter((note) => note.message)
  if (!notes.length && !record.blocking) return null
  return { notes, blocking: typeof record.blocking === 'number' ? record.blocking : 0 }
}

const SEVERITY_DOT: Record<FlowImportNote['severity'], string> = {
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-400',
}

/**
 * What the importer couldn't translate faithfully, persisted on the flow so it
 * outlives the import toast. Mirrors the checker panel's layout; the Flow
 * checker stays the live source of truth for CURRENT problems — this panel is
 * the record of what the import changed or skipped.
 */
export function ImportNotesPanel({
  report,
  onJump,
  onClear,
  canClear,
  onClose,
}: {
  report: FlowImportReport
  onJump: (nodeId: string) => void
  /** Deletes the persisted report (PUT clearImportNotes). */
  onClear: () => void
  /** Clearing edits the flow — hidden for view-only + external guests. */
  canClear: boolean
  onClose: () => void
}) {
  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <FileWarning className="h-4 w-4 text-amber-600" /> Import notes
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-border px-4 py-2">
        <p className="text-xs text-muted-foreground">
          {report.blocking > 0
            ? `This import started with ${report.blocking} blocking problem${report.blocking === 1 ? '' : 's'} — the Flow checker tracks what's still open.`
            : 'Nothing here blocks the flow — these notes record what the import changed or skipped.'}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto">
        {report.notes.map((note, index) => {
          const content = (
            <>
              <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', SEVERITY_DOT[note.severity])} />
              <span className="min-w-0 flex-1 text-sm">{note.message}</span>
            </>
          )
          return note.nodeId ? (
            <button
              key={`${note.code}-${index}`}
              type="button"
              onClick={() => onJump(note.nodeId!)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
            >
              {content}
            </button>
          ) : (
            <div key={`${note.code}-${index}`} className="flex items-start gap-2 px-3 py-2">
              {content}
            </div>
          )
        })}
      </div>
      {canClear && (
        <div className="border-t border-border p-3">
          <Button variant="ghost" size="sm" className="w-full" onClick={onClear}>
            <Trash2 className="mr-1.5 h-4 w-4" /> Clear notes
          </Button>
        </div>
      )}
    </div>
  )
}
