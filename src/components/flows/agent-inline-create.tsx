'use client'

import { useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { Bot, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * Inline agent creation for agent steps with no agent bound yet: name +
 * instructions right in the builder, so a flow-oriented agent (n8n-style —
 * instructions here, chat model / memory / tools on the step) never requires a
 * detour through the dashboard. POSTs the real /api/agents create, then hands
 * the new agent back so the step binds to it immediately.
 */
export function AgentInlineCreate({
  onCreated,
  className,
}: {
  onCreated: (agent: { id: string; title: string }) => void
  className?: string
}) {
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [creating, setCreating] = useState(false)

  const create = async () => {
    if (!title.trim() || !instructions.trim()) {
      toast.error('Give the agent a name and instructions first.')
      return
    }
    setCreating(true)
    try {
      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), instructions: instructions.trim() }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.agent?.id) {
        toast.error(typeof data?.error === 'string' ? data.error : 'Could not create the agent.')
        return
      }
      toast.success(`Agent “${data.agent.title}” created and attached to this step.`)
      onCreated({ id: data.agent.id, title: data.agent.title })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className={cn('space-y-3 rounded-lg border border-dashed border-indigo-300 bg-indigo-50/50 p-3', className)}>
      <div className="flex items-start gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <Bot className="h-4 w-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-slate-900">Create a custom agent for this step</p>
          <p className="text-xs text-slate-500">
            Write its instructions here; set its chat model, memory, and tools in the section below once attached.
          </p>
        </div>
      </div>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-indigo-400"
        placeholder="Agent name — e.g. Pipeline Persona Analyst"
        aria-label="New agent name"
      />
      <textarea
        onKeyDown={indentOnTab}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        rows={4}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400 focus:border-indigo-400"
        placeholder="Instructions — who this agent is, what it does, and how it should respond."
        aria-label="New agent instructions"
      />
      <button
        type="button"
        onClick={create}
        disabled={creating}
        className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-60"
      >
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
        {creating ? 'Creating…' : 'Create agent & attach'}
      </button>
    </div>
  )
}
