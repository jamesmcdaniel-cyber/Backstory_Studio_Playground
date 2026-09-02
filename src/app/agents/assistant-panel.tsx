'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { describeSchedule } from '@/lib/scheduling/cadence'
import { toast } from 'sonner'
import { ArrowRight, Check, Clock, Loader2, MessageSquare, Play, Plus, Send, Settings2, Sparkles, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HtmlPreview, looksLikeHtml, unwrapHtmlFence } from '@/components/ui/html-preview'
import { Markdown } from '@/components/ui/markdown'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'
import { useAssistantSurface } from '@/components/assistant/assistant-surface'

/**
 * Persistent assistant chat for the selected agent. The thread is agent-scoped
 * (not per-execution): the server grounds answers in the agent's config and
 * recent runs, and change requests come back as proposals the user applies via
 * the existing agent update API after an explicit confirm.
 *
 * A proposal targets one of two things, and the card says which: `update`
 * changes the agent in view, `new` stands up a separate agent from the proposed
 * instructions that inherits this agent's tools, skills and model. Both actions
 * stay available on every proposal, so a misjudged target is one click to fix
 * rather than a re-prompt.
 */

type ProposalSchedule = {
  type: string
  time?: string
  cron?: string
  timezone: string
  isActive: boolean
}

/** Which agent an applied proposal lands on. */
type ProposalTarget = 'update' | 'new'

type AssistantProposal = {
  summary: string
  target?: ProposalTarget
  title?: string
  description?: string
  instructions?: string
  model?: string
  integrations?: string[]
  skills?: string[]
  schedule?: ProposalSchedule
}

type ChatMessage = {
  id: string
  role: string
  content: string
  createdAt: string
  proposal?: AssistantProposal | null
  appliedAt?: string | null
  /** Set when applying this proposal created a separate agent. */
  createdAgentId?: string | null
  /** Set when this reply came from (or started) an agent run. */
  run?: { task?: string; executionId?: string; status?: string } | null
}

type SessionSummary = {
  id: string
  title: string
  updatedAt: string
  messageCount: number
}

/** Compact relative time for the history list, e.g. "just now", "2h", "3d". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w`
  return `${Math.floor(days / 30)}mo`
}

/** Plain English only — a proposal must never show raw cron syntax. */
function scheduleLabel(schedule: ProposalSchedule): string {
  if (schedule.type === 'manual') return 'manual'
  const described = describeSchedule(schedule as Parameters<typeof describeSchedule>[0])
  return `${described} (${schedule.timezone})${schedule.isActive ? '' : ' (paused)'}`
}

function proposalRows(proposal: AssistantProposal): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  if (proposal.title) rows.push({ label: 'Name', value: proposal.title })
  if (proposal.description) rows.push({ label: 'Description', value: proposal.description })
  if (proposal.instructions) rows.push({ label: 'Instructions', value: proposal.instructions })
  if (proposal.model) rows.push({ label: 'Model', value: proposal.model })
  if (proposal.integrations) rows.push({ label: 'Connected tools', value: proposal.integrations.join(', ') || 'none' })
  if (proposal.skills) rows.push({ label: 'Skills', value: proposal.skills.join(', ') || 'none' })
  if (proposal.schedule) rows.push({ label: 'Schedule', value: scheduleLabel(proposal.schedule) })
  return rows
}

/**
 * Agent text as the user should see it: a house-format HTML report renders as
 * the report (even if the model fenced it), anything else renders as Markdown.
 */
function AgentOutput({ text }: { text: string }) {
  const content = unwrapHtmlFence(text)
  return looksLikeHtml(content) ? <HtmlPreview html={content} /> : <Markdown>{content}</Markdown>
}

function ProposalCard({
  message,
  agentTitle,
  applying,
  onApply,
  onOpenAgent,
}: {
  message: ChatMessage
  agentTitle: string
  applying: boolean
  onApply: (target: ProposalTarget) => void
  onOpenAgent?: (agentId: string) => void
}) {
  const proposal = message.proposal
  if (!proposal) return null
  const rows = proposalRows(proposal)
  const isNew = proposal.target === 'new'
  // A separate agent needs instructions to run on; without them only the
  // update action makes sense.
  const canCreateNew = Boolean(proposal.instructions?.trim())
  const createdAgentId = message.createdAgentId
  return (
    <div className="mt-2 rounded-lg border bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="eyebrow">{isNew ? 'New agent' : 'Proposed changes'}</p>
        {message.appliedAt && (
          <Badge variant="outline" className="gap-1 border-green-200 text-green-700">
            <Check className="h-3 w-3" /> {createdAgentId ? 'Created' : 'Applied'}
          </Badge>
        )}
      </div>
      <p className="text-sm text-gray-700">{proposal.summary}</p>
      {isNew && !message.appliedAt && (
        <p className="mt-1 text-xs text-gray-500">
          This creates a separate agent. It keeps the same connected tools, skills and model as {agentTitle}, so only the
          name, description and instructions differ.
        </p>
      )}
      {rows.length > 0 && (
        <dl className="mt-2 space-y-2 border-t pt-2">
          {rows.map((row) => (
            <div key={row.label}>
              <dt className="mono-label">{row.label}</dt>
              <dd className="mt-0.5 max-h-36 overflow-y-auto whitespace-pre-wrap text-sm text-gray-700">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* Both destinations stay one click away until the user picks one, so a
          proposal aimed at the wrong agent never has to be re-prompted. */}
      {!message.appliedAt && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {isNew ? (
            <>
              <Button variant="ghost" size="sm" disabled={applying} onClick={() => onApply('update')}>
                Change this agent instead
              </Button>
              <Button size="sm" disabled={applying} onClick={() => onApply('new')}>
                {applying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                Create new agent
              </Button>
            </>
          ) : (
            <>
              {canCreateNew && (
                <Button variant="ghost" size="sm" disabled={applying} onClick={() => onApply('new')}>
                  Save as a new agent
                </Button>
              )}
              <Button size="sm" disabled={applying} onClick={() => onApply('update')}>
                {applying ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                Apply changes
              </Button>
            </>
          )}
        </div>
      )}
      {createdAgentId && onOpenAgent && (
        <div className="mt-3 flex justify-end">
          <Button variant="outline" size="sm" className="max-w-full" onClick={() => onOpenAgent(createdAgentId)}>
            <span className="truncate">Open {proposal.title || 'the new agent'}</span>
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 shrink-0" />
          </Button>
        </div>
      )}
    </div>
  )
}

export function AssistantPanel({
  agent,
  hasFailedRun,
  runOutput,
  onAgentUpdated,
  onOpenAgent,
}: {
  agent: Agent | null
  hasFailedRun?: boolean
  /** The run expanded on the left, whose output renders at the top here. */
  runOutput?: { title: string; at: string; status: string; text: string } | null
  onAgentUpdated: () => void
  /** Select another agent — used to jump to one a proposal just created. */
  onOpenAgent?: (agentId: string) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  // Conversation state: the active session (null = a fresh, not-yet-saved chat)
  // and this agent's history for the current user.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // Ask Backstory's floating launcher shares this corner; it steps aside
  // while this panel is on screen. See components/assistant/assistant-surface.
  useAssistantSurface(panelRef)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  // The in-flight ask, so the stop button (and an agent switch) can cancel it.
  const abortRef = useRef<AbortController | null>(null)
  const agentId = agent?.id
  // Tracks the currently-targeted agent so in-flight async completions can
  // detect an agent switch and avoid mutating another agent's thread.
  const agentIdRef = useRef(agentId)

  // History is per agent + per rep: refetch the session list whenever the agent
  // changes (server scopes it to this agent and the authenticated user).
  const loadSessions = useCallback(async (targetAgentId: string) => {
    try {
      const response = await fetch(`/api/agents/${targetAgentId}/chat/sessions`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (agentIdRef.current !== targetAgentId) return
      setSessions(Array.isArray(data.sessions) ? data.sessions : [])
    } catch {
      if (agentIdRef.current === targetAgentId) setSessions([])
    }
  }, [])

  useEffect(() => {
    agentIdRef.current = agentId
    setHistoryOpen(false)
    // Abandon any in-flight ask — its response belongs to the previous agent's
    // thread — and re-enable the composer for the newly selected one.
    abortRef.current?.abort()
    setSending(false)
    // Start every agent on a FRESH chat rather than auto-restoring its most
    // recent conversation. Prior chats aren't lost — they're saved per agent +
    // per rep and reachable from the history (clock) dropdown — they're just
    // not reopened into the view. So a new login always opens a clean chat.
    setMessages([])
    setSessionId(null)
    if (!agentId) {
      setSessions([])
      return
    }
    // Only the history list loads on select; the conversation stays empty.
    void loadSessions(agentId)
  }, [agentId, loadSessions])

  // Close the history dropdown on an outside click.
  useEffect(() => {
    if (!historyOpen) return
    const onClick = (event: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [historyOpen])

  const startNewChat = () => {
    setHistoryOpen(false)
    setSessionId(null)
    setMessages([])
    setInput('')
  }

  const selectSession = async (id: string) => {
    setHistoryOpen(false)
    if (!agentId || id === sessionId) return
    const targetAgentId = agentId
    setLoading(true)
    setMessages([])
    try {
      const response = await fetch(`/api/agents/${targetAgentId}/chat?sessionId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (agentIdRef.current !== targetAgentId) return
      setMessages(Array.isArray(data.messages) ? data.messages : [])
      setSessionId(typeof data.sessionId === 'string' ? data.sessionId : id)
    } finally {
      if (agentIdRef.current === targetAgentId) setLoading(false)
    }
  }

  // Keep the newest message in view as the thread grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, sending])

  // The composer grows with its content up to a quarter of the panel's height,
  // then scrolls internally so a long prompt stays fully reviewable.
  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    const cap = Math.max(96, Math.floor((panelRef.current?.clientHeight ?? 600) / 4))
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resizeComposer()
  }, [input, resizeComposer])

  useEffect(() => {
    window.addEventListener('resize', resizeComposer)
    return () => window.removeEventListener('resize', resizeComposer)
  }, [resizeComposer])

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim()
    if (!agentId || !content || sending) return
    const targetAgentId = agentId
    setInput('')
    setSending(true)
    const controller = new AbortController()
    abortRef.current = controller
    const localId = `local-${Date.now()}`
    setMessages((previous) => [
      ...previous,
      { id: localId, role: 'user', content, createdAt: new Date().toISOString() },
    ])
    // A legacy synthetic thread is read-only; sending from it opens a fresh
    // session rather than appending to the null-session bucket.
    const targetSessionId = sessionId && sessionId !== 'legacy' ? sessionId : undefined
    try {
      const response = await fetch(`/api/agents/${targetAgentId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, ...(targetSessionId ? { sessionId: targetSessionId } : {}) }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => ({}))
      // The user switched agents while the request was in flight; this
      // response belongs to another agent's thread, so leave state alone.
      if (agentIdRef.current !== targetAgentId) return
      if (!response.ok) {
        toast.error(data.error || 'The assistant is unavailable right now.')
        setMessages((previous) => previous.filter((message) => message.id !== localId))
        setInput(content)
        return
      }
      const returned: ChatMessage[] = Array.isArray(data.messages) ? data.messages : []
      setMessages((previous) => [
        ...previous.filter((message) => message.id !== localId),
        ...returned,
      ])
      if (typeof data.sessionId === 'string') setSessionId(data.sessionId)
      // Refresh history so a new chat appears / its title + ordering update.
      void loadSessions(targetAgentId)
      // A reply that ran the agent added a run — refresh the activity list too.
      if (returned.some((message) => message.run)) onAgentUpdated()
    } catch (error) {
      if (agentIdRef.current !== targetAgentId) return
      // Stopped by the user (or the network dropped): withdraw the optimistic
      // message and put the text back so it can be edited and resent.
      setMessages((previous) => previous.filter((message) => message.id !== localId))
      setInput(content)
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        toast.error('Could not reach the assistant — check your connection and try again.')
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      if (agentIdRef.current === targetAgentId) setSending(false)
    }
  }

  const applyProposal = async (message: ChatMessage, target: ProposalTarget) => {
    if (!agent || !message.proposal || applyingId) return
    setApplyingId(message.id)
    try {
      // Strip the display-only fields; everything else maps onto the existing
      // /api/agents payloads. `new` posts a create keyed to this agent, so the
      // new agent inherits its tools, skills and model and overrides only what
      // the proposal names; `update` puts the changes onto this agent.
      const { summary, target: proposed, ...changes } = message.proposal
      void summary
      void proposed
      const creating = target === 'new'
      const response = await fetch('/api/agents', {
        method: creating ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creating ? { cloneFrom: agent.id, ...changes } : { id: agent.id, ...changes }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || (creating ? 'Could not create the agent.' : 'Could not apply the changes.'))
        return
      }
      const createdAgentId = creating && typeof data.agent?.id === 'string' ? (data.agent.id as string) : null
      // Best-effort: persist the applied marker on the proposal message.
      fetch(`/api/agents/${agent.id}/chat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: message.id, ...(createdAgentId ? { createdAgentId } : {}) }),
      }).catch(() => undefined)
      setMessages((previous) => previous.map((candidate) =>
        candidate.id === message.id
          ? { ...candidate, appliedAt: new Date().toISOString(), createdAgentId }
          : candidate,
      ))
      toast.success(createdAgentId ? `Created ${data.agent?.title || 'the new agent'}.` : 'Agent configuration updated.')
      notifyAgentsChanged()
      onAgentUpdated()
    } finally {
      setApplyingId(null)
    }
  }

  // Task-oriented starters that reflect what these agents do (run it, research,
  // briefing) plus quick config — not just "what did the last run do".
  const suggestions: Array<{ text: string; kind: 'action' | 'question' }> = agent
    ? [
        { text: 'Run this agent now', kind: 'action' },
        { text: 'Change the schedule to run daily at 9am', kind: 'action' },
        { text: 'Summarize the key findings from the latest run', kind: 'question' },
        ...(hasFailedRun
          ? [{ text: 'Why did the last run fail?', kind: 'question' as const }]
          : [{ text: 'Draft a short brief from the most recent run', kind: 'question' as const }]),
        { text: 'What should I follow up on next?', kind: 'question' },
      ]
    : []

  // Always a chat window: header, scrollable transcript, composer pinned to the
  // bottom. Before an agent is picked the composer stays visible but disabled so
  // the pane reads as a chat surface rather than an empty placeholder.
  return (
    <div ref={panelRef} className="flex h-full min-h-0 flex-col">
      <div className="border-b p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="eyebrow">Assistant</p>
            <h2 className="mt-1 truncate font-semibold">{agent ? agent.title : 'No agent selected'}</h2>
          </div>
          {agent && (
            <div className="flex shrink-0 items-center gap-1" ref={historyRef}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="New chat"
                title="New chat"
                onClick={startNewChat}
                disabled={sending}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <div className="relative">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Chat history"
                  title="Chat history"
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <Clock className="h-4 w-4" />
                </Button>
                {historyOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-md">
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Chat history</p>
                    {sessions.length === 0 ? (
                      <p className="px-3 pb-3 pt-1 text-sm text-gray-500">No past chats yet.</p>
                    ) : (
                      <ul className="max-h-72 overflow-y-auto pb-1">
                        {sessions.map((session) => (
                          <li key={session.id}>
                            <button
                              type="button"
                              onClick={() => selectSession(session.id)}
                              className={cn(
                                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                                session.id === sessionId && 'bg-accent/60',
                              )}
                            >
                              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                              <span className="min-w-0 flex-1 truncate">{session.title}</span>
                              <span className="shrink-0 text-xs text-fg-muted">{relativeTime(session.updatedAt)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {agent
            ? 'Ask about runs, change configuration, or tell the agent what to do — it runs with its connected tools.'
            : 'Pick an agent to ask about its runs, change its configuration, or put it to work.'}
        </p>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto" role="log" aria-live="polite" aria-busy={sending} aria-relevant="additions">
        {!agent && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="max-w-sm text-center">
              <MessageSquare className="mx-auto h-6 w-6 text-gray-300" />
              <p className="mt-2 text-sm text-gray-500">
                This is where you talk to your agents — ask what a run did, walk through an error, or describe a change. Select an agent to begin.
              </p>
            </div>
          </div>
        )}
        {agent && loading && (
          <div className="flex flex-1 items-center justify-center p-6 text-gray-500"><Loader2 className="h-5 w-5 animate-spin" /></div>
        )}
        {/* Empty chat (no output, no messages): center the starters vertically. */}
        {agent && !loading && !runOutput && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="w-full max-w-sm text-center">
              <MessageSquare className="mx-auto h-6 w-6 text-gray-300" />
              <p className="mt-2 text-sm text-gray-500">
                Backstory grounds answers in this agent&apos;s configuration and recent runs — and runs the agent for you when you ask.
              </p>
              <div className="mt-4 space-y-4 text-left">
                {(['action', 'question'] as const).map((kind) => {
                  const items = suggestions.filter((suggestion) => suggestion.kind === kind)
                  if (!items.length) return null
                  return (
                    <div key={kind}>
                      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted">
                        {kind === 'action' ? <Settings2 className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
                        {kind === 'action' ? 'Quick actions' : 'Ask about this agent'}
                      </p>
                      <div className="space-y-2">
                        {items.map((suggestion) => (
                          <button
                            key={suggestion.text}
                            type="button"
                            disabled={sending}
                            onClick={() => send(suggestion.text)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-150',
                              kind === 'action'
                                ? 'border-horizon-200 bg-horizon-50/60 text-horizon-800 hover:border-horizon-400 hover:bg-horizon-50'
                                : 'bg-white text-gray-700 hover:border-indigo-200 hover:bg-indigo-50',
                            )}
                          >
                            {kind === 'action' && <Play className="h-3.5 w-3.5 shrink-0" />}
                            {suggestion.text}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        {/* Content flow: the selected run's output on top, then the conversation. */}
        {agent && !loading && (runOutput || messages.length > 0 || sending) && (
          <div className="space-y-3 p-4">
            {runOutput && (
              <div className={cn('rounded-lg border p-3', runOutput.status === 'failed' ? 'border-red-200 bg-red-50' : 'bg-white')}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="eyebrow">{runOutput.status === 'failed' ? 'Run error' : 'Output'} · {runOutput.title}</p>
                  <span className="shrink-0 text-xs text-fg-muted">{new Date(runOutput.at).toLocaleString()}</span>
                </div>
                <div className={cn('text-sm', runOutput.status === 'failed' && 'whitespace-pre-wrap text-red-700')}>
                  {runOutput.status === 'failed' ? runOutput.text : <AgentOutput text={runOutput.text} />}
                </div>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  'rounded-lg p-3 text-sm transition-colors duration-150',
                  message.role === 'user' ? 'ml-8 bg-indigo-50' : 'mr-8 border bg-gray-50',
                )}
              >
                {message.role !== 'user' && message.run && (
                  <p className="eyebrow mb-2 flex items-center gap-1.5">
                    <Play className="h-3 w-3" />
                    Agent run
                    {message.run.status === 'failed' && <span className="text-red-600">— failed</span>}
                    {message.run.status === 'pending' && <span className="text-gray-500">— running</span>}
                    {(message.run.status === 'waiting_for_input' || message.run.status === 'waiting_for_approval') && (
                      <span className="text-amber-600">— waiting</span>
                    )}
                  </p>
                )}
                {message.role === 'user'
                  ? <p className="whitespace-pre-wrap">{message.content}</p>
                  : <AgentOutput text={message.content} />}
                {message.role !== 'user' && message.proposal && (
                  <ProposalCard
                    message={message}
                    agentTitle={agent.title}
                    applying={applyingId === message.id}
                    onApply={(target) => applyProposal(message, target)}
                    onOpenAgent={onOpenAgent}
                  />
                )}
              </div>
            ))}
            {sending && (
              <div className="mr-8 flex items-center gap-2 rounded-lg border bg-gray-50 p-3 text-sm text-gray-500" role="status">
                <Loader2 className="h-4 w-4 animate-spin" /> Working — a live run can take a few minutes…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t p-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends (except mid-IME composition); Shift+Enter breaks the line.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              } else {
                indentOnTab(event)
              }
            }}
            placeholder={agent ? `Ask about ${agent.title}...` : 'Select an agent to start chatting…'}
            disabled={!agent || sending}
            aria-label="Message the assistant"
            className="min-h-9 w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors duration-fast placeholder:text-muted-foreground hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {sending ? (
            <Button size="icon" onClick={() => abortRef.current?.abort()} aria-label="Stop response" title="Stop">
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon" disabled={!agent || !input.trim()} onClick={() => send()} aria-label="Send message">
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
