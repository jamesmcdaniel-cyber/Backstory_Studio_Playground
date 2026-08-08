'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * Importing a flow — from a JSON file (Backstory package or n8n workflow) or a
 * URL — always creates a NEW draft and navigates to it. Shared by the flows
 * list and the builder's settings menu so both offer identical behavior.
 * Render `fileInput` and `urlDialog` once in the consuming component;
 * `pickFile` opens the file picker, `importFromUrl` opens the URL dialog.
 */
export function useFlowImport() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [importing, setImporting] = useState(false)

  const finishImport = useCallback(
    (response: Response, data: { flow?: { id?: string }; warnings?: string[]; blocking?: number; source?: string; error?: string }) => {
      if (!response.ok || !data.flow?.id) {
        toast.error(data.error || 'That is not a valid Backstory flow package or n8n workflow.')
        return
      }
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      const blocking = typeof data.blocking === 'number' ? data.blocking : 0
      if (data.source === 'n8n') {
        // The full report is persisted on the flow (Import notes panel) — the
        // toast just headlines it, and no longer evaporates the only copy.
        toast.success(
          blocking > 0
            ? `Imported from n8n as a draft — ${blocking} problem${blocking === 1 ? '' : 's'} to fix and ${warnings.length} note${warnings.length === 1 ? '' : 's'} (open Import notes in the builder).`
            : warnings.length > 0
              ? `Imported from n8n as a draft — ${warnings.length} note${warnings.length === 1 ? '' : 's'} (open Import notes in the builder).`
              : 'Imported from n8n as a draft, ready to run.',
          { duration: 8000 },
        )
      } else {
        toast.success('Flow imported as a draft.')
      }
      router.push(`/flows/${data.flow.id}`)
    },
    [router],
  )

  const importFile = useCallback(
    async (file: File) => {
      if (file.size > 5_000_000) return void toast.error('Flow packages must be under 5 MB.')
      try {
        const payload = JSON.parse(await file.text())
        const response = await fetch('/api/flows/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const data = await response.json().catch(() => ({}))
        finishImport(response, data)
      } catch {
        toast.error('Could not read that JSON file.')
      }
    },
    [finishImport],
  )

  // URL import (n8n parity): paste an n8n.io template page URL or any link to
  // raw workflow JSON — the server fetches it (browser CORS can't) and
  // converts it the same way as a file import.
  const submitUrl = useCallback(async () => {
    const trimmed = url.trim()
    if (!trimmed || importing) return
    setImporting(true)
    try {
      const response = await fetch('/api/flows/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: trimmed }) })
      const data = await response.json().catch(() => ({}))
      finishImport(response, data)
      if (response.ok) {
        setUrlOpen(false)
        setUrl('')
      }
    } catch {
      toast.error('Could not import from that URL.')
    } finally {
      setImporting(false)
    }
  }, [finishImport, importing, url])

  const fileInput = (
    <input
      ref={inputRef}
      className="hidden"
      type="file"
      accept="application/json,.json"
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void importFile(file)
      }}
    />
  )

  const urlDialog = (
    <Dialog open={urlOpen} onOpenChange={(open) => { if (!importing) setUrlOpen(open) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import from a URL</DialogTitle>
          <DialogDescription>Paste an n8n.io template page URL, or a link to a workflow/flow JSON file.</DialogDescription>
        </DialogHeader>
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void submitUrl() }}
          placeholder="https://n8n.io/workflows/…"
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setUrlOpen(false)} disabled={importing}>Cancel</Button>
          <Button onClick={() => void submitUrl()} loading={importing} disabled={!url.trim() || importing}>Import</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { fileInput, urlDialog, pickFile: () => inputRef.current?.click(), importFromUrl: () => setUrlOpen(true) }
}
