'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Sparkles, Send, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { FlowGraph } from '@/lib/flows/graph'
import type { CopilotOp } from '@/lib/flows/copilot-ops'

type NeedsAttentionItem = { nodeId?: string; message: string }

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  resultLine?: string
  needsAttention?: NeedsAttentionItem[]
  error?: boolean
}

const HISTORY_CAP = 20

export function CopilotPanel({
  graph,
  onGraph,
  onOps,
  onJump,
  onNeedsAttention,
  external = false,
}: {
  graph: FlowGraph
  onGraph: (graph: FlowGraph) => void
  onOps: (ops: CopilotOp[]) => { applied: number; skipped: { reason: string }[] }
  onJump: (nodeId: string) => void
  onNeedsAttention?: (issues: NeedsAttentionItem[]) => void
  /** Cross-workspace guest: chat goes structure-only (no roster/tools) and the
   *  whole-flow generate path is hidden — generation grounds on the caller's
   *  workspace, which is the wrong org for a shared flow. */
  external?: boolean
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The graph prop (and the page's onOps closure over it) changes on every
  // edit; refs keep the async send handler reading the latest canvas instead
  // of the render it was created in — otherwise a mid-request manual edit
  // would be clobbered when the response ops apply against the old graph.
  const graphRef = useRef(graph)
  graphRef.current = graph
  const onOpsRef = useRef(onOps)
  onOpsRef.current = onOps

  const emptyCanvas = graph.nodes.length <= 1 && !external

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  const resizeInput = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

  // The one-shot generate path: drafts a whole flow from a description and
  // replaces the canvas. Kept as the empty-canvas quick action.
  const generate = async () => {
    const description = input.trim()
    if (!description || loading) return
    setLoading(true)
    try {
      const response = await fetch('/api/flows/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      const data = await response.json()
      if (response.ok && data.success && data.graph) {
        const steps = (data.graph.nodes || []).filter((n: { type: string }) => n.type !== 'trigger').length
        onGraph(data.graph)
        onNeedsAttention?.(data.needsAttention ?? [])
        setInput('')
        const errors = data.validation?.errors?.length ?? 0
        if (errors) {
          toast.warning(`Drafted ${steps} step${steps === 1 ? '' : 's'}, but ${errors} check${errors === 1 ? '' : 's'} need attention.`)
        } else {
          toast.success(steps ? `Drafted ${steps} step${steps === 1 ? '' : 's'} — review before running.` : 'No matching steps found for that description.')
        }
      } else {
        toast.error(data.error || 'Could not generate a flow.')
      }
    } finally {
      setLoading(false)
      requestAnimationFrame(resizeInput)
    }
  }

  const send = async () => {
    const content = input.trim()
    if (!content || loading) return
    // Error bubbles stay in the thread for the user, but must not replay to
    // the model as genuine assistant turns.
    const history = [...messages.filter((message) => !message.error).map(({ role, content: text }) => ({ role, content: text })), { role: 'user' as const, content }].slice(-HISTORY_CAP)
    setMessages((prev) => [...prev, { role: 'user', content }])
    setInput('')
    setLoading(true)
    try {
      const response = await fetch('/api/flows/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, graph: graphRef.current, ...(external ? { external: true } : {}) }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        const result = onOpsRef.current((data.ops ?? []) as CopilotOp[])
        const parts: string[] = []
        if (result.applied > 0) parts.push(`Applied ${result.applied} change${result.applied === 1 ? '' : 's'}`)
        if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`)
        const needsAttention = (data.needsAttention ?? []) as NeedsAttentionItem[]
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.message || 'Done.',
            resultLine: parts.length ? parts.join(' · ') : undefined,
            needsAttention: needsAttention.length ? needsAttention : undefined,
          },
        ])
        onNeedsAttention?.(needsAttention)
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: data.error || 'Could not apply that change — try again.', error: true }])
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Could not reach the copilot — check your connection and try again.', error: true }])
    } finally {
      setLoading(false)
      requestAnimationFrame(resizeInput)
    }
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter during IME composition commits the candidate, not the message.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-indigo-500" />
        <h2 className="text-sm font-semibold">Copilot</h2>
      </div>

      <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {emptyCanvas
              ? 'Describe what the flow should do and I’ll draft runnable steps from your agents and connected tools.'
              : 'Ask for changes in plain language — add, edit, move, or remove steps — and I’ll apply them to the canvas.'}
          </p>
        )}
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-sm text-foreground">{message.content}</div>
            </div>
          ) : (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/40">
                <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
              </span>
              <div className="min-w-0 max-w-[85%] space-y-1.5">
                <div
                  className={cn(
                    'whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm',
                    message.error ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-200' : 'border-border bg-background text-foreground',
                  )}
                >
                  {message.content}
                </div>
                {message.resultLine && <p className="px-1 text-[11px] font-medium text-muted-foreground">{message.resultLine}</p>}
                {message.needsAttention?.map((issue, issueIndex) =>
                  issue.nodeId ? (
                    <button
                      key={issueIndex}
                      type="button"
                      onClick={() => onJump(issue.nodeId!)}
                      className="flex w-full items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-left text-[11px] text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-950/60"
                    >
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {issue.message}
                    </button>
                  ) : (
                    <p key={issueIndex} className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                      {issue.message}
                    </p>
                  ),
                )}
              </div>
            </div>
          ),
        )}
        {loading && (
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/40">
              <Sparkles className="h-3.5 w-3.5 animate-pulse text-indigo-500" />
            </span>
            <p className="text-xs text-muted-foreground">Thinking…</p>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border p-3">
        {emptyCanvas && (
          <Button variant="outline" size="sm" className="w-full" onClick={generate} disabled={loading || !input.trim()}>
            <Sparkles className="mr-1.5 h-4 w-4 text-indigo-500" /> Generate a flow
          </Button>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              resizeInput()
            }}
            onKeyDown={onInputKeyDown}
            placeholder={emptyCanvas ? 'e.g. Score my in-segment accounts and post the top 20 to #sales.' : 'Ask for a change…'}
            className="max-h-[140px] min-h-[38px] w-full flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300"
            aria-label="Message the copilot"
          />
          <Button size="icon" onClick={send} loading={loading} disabled={!input.trim()} aria-label="Send message">
            {!loading && <Send className="h-4 w-4" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {emptyCanvas ? 'AI-generated — Generate replaces the canvas. Review before running.' : 'AI edits apply directly to the canvas — ⌘Z to undo.'}
        </p>
      </div>
    </div>
  )
}
