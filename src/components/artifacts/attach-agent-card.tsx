'use client'

import { useEffect, useState } from 'react'
import { Bot, Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

type AgentOption = { id: string; title: string }

/**
 * An artifact with no agent behind it can't be asked for changes. Attach one
 * the person already uses, or make a background agent just for this artifact.
 */
export function AttachAgentCard({ artifactId, onAttached }: { artifactId: string; onAttached: () => void }) {
  const [agents, setAgents] = useState<AgentOption[] | null>(null)
  const [agentId, setAgentId] = useState('')
  const [busy, setBusy] = useState<'attach' | 'create' | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/agents', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { agents?: Array<{ id: string; title?: string; description?: string }> }) => {
        if (cancelled) return
        const list = (data.agents ?? []).map((agent) => ({ id: agent.id, title: agent.title || agent.description?.split('\n')[0] || 'Untitled agent' }))
        setAgents(list)
        if (list.length) setAgentId(list[0].id)
      })
      .catch(() => { if (!cancelled) setAgents([]) })
    return () => { cancelled = true }
  }, [])

  const attach = async (body: Record<string, unknown>, kind: 'attach' | 'create') => {
    setBusy(kind)
    try {
      const response = await fetch(`/api/artifacts/${artifactId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The agent could not be attached.')
      toast.success(kind === 'create' ? `${data.agent?.title ?? 'An agent'} was made for this artifact — ask it for changes.` : `${data.agent?.title ?? 'The agent'} now works on this artifact.`)
      onAttached()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3 text-sm">
      <div>
        <p className="font-medium">No agent is attached</p>
        <p className="mt-0.5 text-xs text-muted-foreground">An agent makes this artifact's changes and answers questions about it, with its own tools and integrations.</p>
      </div>
      <Button size="sm" className="w-full" disabled={busy !== null} onClick={() => void attach({ createAgent: true }, 'create')}>
        {busy === 'create' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />}Create an agent for this artifact
      </Button>
      {agents && agents.length > 0 && (
        <div className="space-y-1.5">
          <label htmlFor="attach-agent" className="text-xs text-muted-foreground">Or attach one you already use</label>
          <div className="flex gap-2">
            <select id="attach-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm">
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.title}</option>)}
            </select>
            <Button size="sm" variant="outline" disabled={!agentId || busy !== null} onClick={() => void attach({ agentId }, 'attach')}>
              {busy === 'attach' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Bot className="mr-1 h-4 w-4" aria-hidden />}Attach
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
