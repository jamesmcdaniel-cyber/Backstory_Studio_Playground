'use client'

import { useEffect, useRef, useState } from 'react'
import { Upload, FileText, Trash2, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type KnowledgeDoc = {
  id: string
  filename: string
  sizeBytes: number
  charCount: number
  chunkCount: number
  status: string
  isEnabled: boolean
  createdAt: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Upload + manage the files an agent uses as knowledge (RAG at run time). */
export function KnowledgePanel({ agentId }: { agentId: string }) {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/agents/${agentId}/knowledge`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setDocs(data.success ? data.documents : [])
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('file', file)
        const response = await fetch(`/api/agents/${agentId}/knowledge`, { method: 'POST', body: form })
        const data = await response.json().catch(() => ({}))
        if (response.ok && data.document) {
          setDocs((prev) => [data.document, ...prev])
          toast.success(`Added "${data.document.filename}" (${data.document.chunkCount} passages).`)
        } else {
          toast.error(data.error || `Could not add "${file.name}".`)
        }
      }
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async (doc: KnowledgeDoc) => {
    setDocs((prev) => prev.filter((d) => d.id !== doc.id))
    const response = await fetch(`/api/agents/${agentId}/knowledge`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: doc.id }),
    })
    if (!response.ok) toast.error(`Could not remove "${doc.filename}".`)
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="eyebrow">Knowledge</p>
        <div className="flex gap-2">
          <Button asChild type="button" variant="ghost" size="sm"><Link href="/data-tables">Open repository</Link></Button>
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />}
            Upload files
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log,.pdf,.docx,text/*,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(e) => upload(e.target.files)}
        />
      </div>
      <p className="mb-2 text-xs text-gray-500">
        Files the agent can draw on at run time. Text, Markdown, CSV, JSON, HTML, PDF, DOCX, and source files are supported.
      </p>
      {loading ? (
        <p className="text-sm text-gray-500">
          <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : docs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-sm text-gray-500">No files yet — upload documents to give this agent reference knowledge.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {docs.map((doc) => (
            <li key={doc.id} className="group flex items-center gap-3 px-3 py-2 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="min-w-0 flex-1 truncate text-gray-700" title={doc.filename}>
                {doc.filename}
              </span>
              <span className="shrink-0 text-xs text-fg-muted">
                {formatSize(doc.sizeBytes)} · {doc.chunkCount} passages
              </span>
              {!doc.isEnabled && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase text-gray-500">Disabled</span>}
              <button
                type="button"
                onClick={() => remove(doc)}
                className="shrink-0 text-fg-muted opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                aria-label={`Remove ${doc.filename}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
