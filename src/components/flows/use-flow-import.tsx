'use client'

import { useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

/**
 * Importing a flow — from a JSON file (Backstory package or n8n workflow) or a
 * URL — always creates a NEW draft and navigates to it. Shared by the flows
 * list and the builder's settings menu so both offer identical behavior.
 * Render `fileInput` once in the consuming component; `pickFile` opens it.
 */
export function useFlowImport() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const finishImport = useCallback(
    (response: Response, data: { flow?: { id?: string }; warnings?: string[]; source?: string; error?: string }) => {
      if (!response.ok || !data.flow?.id) {
        toast.error(data.error || 'That is not a valid Backstory flow package or n8n workflow.')
        return
      }
      const warnings = Array.isArray(data.warnings) ? data.warnings : []
      if (data.source === 'n8n') {
        toast.success(
          warnings.length > 0
            ? `Imported from n8n as a draft — ${warnings.length} step${warnings.length === 1 ? '' : 's'} need${warnings.length === 1 ? 's' : ''} attention (see the notes on the canvas).`
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
  const importFromUrl = useCallback(async () => {
    const url = window.prompt('Paste an n8n.io template URL, or a link to a workflow/flow JSON file:')?.trim()
    if (!url) return
    try {
      const response = await fetch('/api/flows/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
      const data = await response.json().catch(() => ({}))
      finishImport(response, data)
    } catch {
      toast.error('Could not import from that URL.')
    }
  }, [finishImport])

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

  return { fileInput, pickFile: () => inputRef.current?.click(), importFromUrl }
}
