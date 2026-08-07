'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Bot, FileText, List, Loader2, Play, Plus, Settings2, Sparkles, X } from 'lucide-react'
import { AgentActivityPane, resultText } from './agent-activity-pane'
import { AgentConfigForm, type AgentDraft } from './agent-config-form'
import { AssistantPanel } from './assistant-panel'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AGENTS_CHANGED_EVENT, notifyAgentsChanged } from '@/components/layout/sidebar'
import { getSnapshot, SnapshotError } from '@/lib/client/snapshot'
import { TemplatesView } from '@/components/templates/templates-view'
import { RecommendationsBar } from '@/components/onboarding/recommendations-bar'
import { ViewToggle, type DashboardView } from './view-toggle'
import { cn } from '@/lib/utils'

import type { Agent, Activity } from '@/lib/types'

type GranolaNote = {
  id: string
  title: string
  owner: { name: string; email: string } | null
  created_at: string | null
}

/** Sentinel selection meaning "setting up a brand-new agent". */
const NEW_AGENT = 'new'

// Right-pane (assistant) width — user-resizable for the current page session.
// Do not restore it after hydration: changing this value after first paint made
// the entire Agents grid visibly resize, unlike every other top-level route.
const ASSISTANT_WIDTH_DEFAULT = 480
const ASSISTANT_WIDTH_MIN = 360
const ASSISTANT_WIDTH_MAX = 800

function clampAssistantWidth(width: number) {
  return Math.min(ASSISTANT_WIDTH_MAX, Math.max(ASSISTANT_WIDTH_MIN, width))
}

function isConfigured(agent: Agent) {
  return agent.status === 'active' && Boolean(agent.instructions?.trim())
}

function AgentHQ() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [agents, setAgents] = useState<Agent[]>([])
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [configureOpen, setConfigureOpen] = useState(false)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  // The run expanded in the left pane, whose output renders in the right pane.
  const [selectedRun, setSelectedRun] = useState<Activity | null>(null)
  const [describe, setDescribe] = useState('')
  const [building, setBuilding] = useState(false)
  // New-agent setup starts as a flows-style choice (Copilot vs. manual fields)
  // instead of dumping the full form; 'choice' until the user picks a path.
  const [setupMode, setSetupMode] = useState<'choice' | 'copilot' | 'manual'>('choice')
  const [runningId, setRunningId] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState<number | null>(null)
  const [granolaPickerOpen, setGranolaPickerOpen] = useState(false)
  const [granolaFetchingList, setGranolaFetchingList] = useState(false)
  const [granolaFetchingNote, setGranolaFetchingNote] = useState(false)
  const [granolaNotes, setGranolaNotes] = useState<GranolaNote[]>([])
  // The initial split is identical on the server, during hydration, and after
  // hydration. It changes only in direct response to a drag in this session.
  const [assistantWidth, setAssistantWidth] = useState<number>(ASSISTANT_WIDTH_DEFAULT)
  const assistantWidthRef = useRef(assistantWidth)
  // The ?agent= id we already refetched for, so a genuinely unknown id costs one
  // refresh and not an endless loop.
  const deepLinkMiss = useRef<string | null>(null)

  // Agents / Templates view, driven by the URL (?view=templates) so it's
  // linkable and the old /templates route can redirect straight into it.
  const view: DashboardView = searchParams.get('view') === 'templates' ? 'templates' : 'agents'
  const setView = useCallback(
    (next: DashboardView) => router.replace(next === 'templates' ? '/agents?view=templates' : '/agents', { scroll: false }),
    [router],
  )
  // Count for the toggle's Templates badge — fetched up front, then kept in sync
  // by the embedded TemplatesView as templates are created/removed.
  const [templateCount, setTemplateCount] = useState<number | null>(null)
  useEffect(() => {
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data?.templates) setTemplateCount(data.templates.length) })
      .catch(() => undefined)
  }, [])

  // Drag-to-resize for the assistant pane's left edge. Grid layout (not the
  // flex row `ResizablePanel` assumes), so the drag math is inlined here and
  // drives `assistantWidth`, which the grid's gridTemplateColumns reads.
  const onAssistantResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = assistantWidthRef.current
    const onMove = (moveEvent: MouseEvent) => {
      // Right pane, so dragging LEFT (smaller clientX) widens it.
      const next = clampAssistantWidth(startWidth + (startX - moveEvent.clientX))
      assistantWidthRef.current = next
      setAssistantWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])
  const resetAssistantWidth = useCallback(() => {
    assistantWidthRef.current = ASSISTANT_WIDTH_DEFAULT
    setAssistantWidth(ASSISTANT_WIDTH_DEFAULT)
  }, [])

  const load = useCallback(async (force = false) => {
    try {
      const snapshot = await getSnapshot(force ? 0 : undefined)
      setAgents(snapshot.agents || [])
      setActivities(snapshot.activities || [])
      setAuthError(null)
      setAuthStatus(null)
    } catch (error) {
      // The gate: no active Sales AI connection — send to the connect flow.
      if (error instanceof SnapshotError && error.code === 'ENTITLEMENT_REQUIRED') {
        window.location.assign('/connect')
        return
      }
      const status = error instanceof SnapshotError ? error.status ?? 500 : 500
      setAuthStatus(status)
      setAuthError(error instanceof Error ? error.message : `Couldn't load agents (HTTP ${status}).`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load().catch(() => setLoading(false))
    // Poll only while the tab is visible — a hidden tab generating 2 API calls
    // every 10s per user is pure load for nothing. Refresh on return instead.
    const interval = window.setInterval(() => {
      if (!document.hidden) load().catch(() => undefined)
    }, 10000)
    const onVisible = () => {
      if (!document.hidden) load().catch(() => undefined)
    }
    const onChanged = () => load(true).catch(() => undefined)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged)
    }
  }, [load])

  // Land on the most recently updated agent unless a deep link already chose.
  useEffect(() => {
    if (loading || selectedAgentId) return
    if (agents.length) setSelectedAgentId(agents[0].id)
  }, [loading, agents, selectedAgentId])

  // Deep links from the command palette and sidebar: ?agent=<id|new>, ?run=<id>.
  useEffect(() => {
    const agentParam = searchParams.get('agent')
    if (!agentParam) return
    if (agentParam === NEW_AGENT) {
      setSelectedAgentId(NEW_AGENT)
      setConfigureOpen(false)
      setFocusRunId(null)
      router.replace('/agents')
      return
    }
    if (loading) return
    if (agents.some((candidate) => candidate.id === agentParam)) {
      setSelectedAgentId(agentParam)
      setConfigureOpen(false)
      setFocusRunId(null)
      router.replace('/agents')
      return
    }
    // The link can name an agent this snapshot predates — one created moments
    // ago on another screen. Refetch once for it rather than dropping the link
    // and silently landing on somebody else's agent.
    if (deepLinkMiss.current !== agentParam) {
      deepLinkMiss.current = agentParam
      load(true).catch(() => undefined)
      return
    }
    router.replace('/agents')
  }, [searchParams, agents, loading, router, load])

  useEffect(() => {
    const runParam = searchParams.get('run')
    if (!runParam || loading) return
    const openRun = (activity: Activity) => {
      if (activity.agentTaskId) setSelectedAgentId(activity.agentTaskId)
      setConfigureOpen(false)
      setFocusRunId(activity.id)
    }
    const activity = activities.find((candidate) => candidate.id === runParam)
    if (activity) {
      openRun(activity)
      router.replace('/agents')
      return
    }
    fetch(`/api/workflows/executions?executionId=${runParam}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        const execution = data.items?.[0]?.execution
        if (execution) openRun(execution)
      })
      .catch(() => undefined)
      .finally(() => router.replace('/agents'))
  }, [searchParams, activities, loading, router])

  // Escape closes the Granola meeting picker (keyboard parity with the close button).
  useEffect(() => {
    if (!granolaPickerOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setGranolaPickerOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [granolaPickerOpen])

  const selectedAgent = useMemo(
    () => agents.find((candidate) => candidate.id === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  )

  const agentActivities = useMemo(
    () => (selectedAgent ? activities.filter((activity) => activity.agentTaskId === selectedAgent.id) : []),
    [activities, selectedAgent],
  )

  const hasFailedRun = useMemo(
    () => agentActivities.some((activity) => activity.status.toLowerCase() === 'failed'),
    [agentActivities],
  )

  // The expanded run's output, shown in the right (assistant) pane.
  const runOutput = useMemo(() => {
    if (!selectedRun) return null
    const text = resultText(selectedRun)
    if (!text) return null
    return {
      title: selectedRun.metadata?.title || selectedRun.agentType,
      at: selectedRun.startedAt,
      status: selectedRun.status.toLowerCase(),
      text,
    }
  }, [selectedRun])

  // A different agent's runs are unrelated — clear the shown output on switch.
  // Switching agents (including into "new") also restarts setup at the choice.
  useEffect(() => {
    setSelectedRun(null)
    setSetupMode('choice')
  }, [selectedAgentId])

  // Setup opens only when creating a new agent, editing an incomplete agent,
  // or explicitly toggling configuration for the selected agent.
  const creatingNew = selectedAgentId === NEW_AGENT
  const showSetup = creatingNew || Boolean(selectedAgent && (!isConfigured(selectedAgent) || configureOpen))
  const editingAgent = showSetup && selectedAgent && selectedAgentId !== NEW_AGENT ? selectedAgent : null

  const selectAgent = (id: string) => {
    setSelectedAgentId(id)
    setConfigureOpen(false)
    setFocusRunId(null)
  }

  const saveAgent = async (draft: AgentDraft) => {
    const response = await fetch('/api/agents', {
      method: editingAgent ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingAgent ? { ...draft, id: editingAgent.id } : draft),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const message = data.error || `Failed to save agent (HTTP ${response.status}).`
      toast.error(message)
      throw new Error(message)
    }
    const data = await response.json().catch(() => ({}))
    notifyAgentsChanged()
    toast.success(editingAgent ? 'Agent updated.' : 'Agent created.')
    setConfigureOpen(false)
    await load(true)
    if (!editingAgent && data.agent?.id) setSelectedAgentId(data.agent.id)
  }

  const buildFromDescription = async () => {
    if (!describe.trim()) return
    setBuilding(true)
    try {
      const response = await fetch('/api/agents/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: describe, create: true }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || `Couldn't build the agent (HTTP ${response.status}).`)
        return
      }
      setDescribe('')
      notifyAgentsChanged()
      toast.success(`Created "${data.draft?.title || 'agent'}".`)
      await load(true)
      if (data.agentId) setSelectedAgentId(data.agentId)
    } finally {
      setBuilding(false)
    }
  }

  const openGranolaPicker = async () => {
    setGranolaFetchingList(true)
    setGranolaNotes([])
    try {
      const response = await fetch('/api/granola/notes')
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Granola not connected')
        return
      }
      setGranolaNotes(data.notes || [])
      setGranolaPickerOpen(true)
    } catch {
      toast.error('Could not reach Granola. Please try again.')
    } finally {
      setGranolaFetchingList(false)
    }
  }

  const importGranolaNote = async (note: GranolaNote) => {
    setGranolaFetchingNote(true)
    try {
      const response = await fetch(`/api/granola/notes/${encodeURIComponent(note.id)}`)
      const data = await response.json().catch(() => ({}))
      if (!data.success) {
        toast.error(data.error || 'Could not load that meeting note.')
        return
      }
      const { title, summary } = data.note as { id: string; title: string; summary: string }
      const prefill = `Build an agent based on this meeting. Identify the workflow or task that was requested and create an agent that carries it out.\n\nMeeting: ${title}\n\n${summary}`
      setDescribe(prefill.slice(0, 3800))
      setGranolaPickerOpen(false)
    } catch {
      toast.error('Could not load that meeting note. Please try again.')
    } finally {
      setGranolaFetchingNote(false)
    }
  }

  const runAgent = async (agent: Agent) => {
    setRunningId(agent.id)
    try {
      const res = await fetch(`/api/agents/${agent.id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        if (data.result?.status === 'waiting_for_input') {
          toast(`${agent.title} needs your input`)
        } else {
          toast.success(`${agent.title} ran`)
        }
        setSelectedAgentId(agent.id)
        setConfigureOpen(false)
        if (data.executionId) setFocusRunId(data.executionId)
        await load(true)
      } else {
        toast.error(data.error || 'Run failed')
      }
    } finally {
      setRunningId(null)
    }
  }

  return (
    // h-full (the shell's content region), never min-h-screen/h-screen: this
    // page already sits inside a viewport-tall <main>, so a second 100vh claim
    // made the shell taller than the window — a page-level scrollbar, the
    // sidebar's footer clipped, and dead canvas showing at the edges.
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:overflow-hidden">
      {/* Agents / Templates toggle — folds the former Templates page into Home. */}
      <div className="flex shrink-0 items-center justify-center border-b bg-white/80 px-4 py-2.5 backdrop-blur-md supports-[backdrop-filter]:bg-white/70">
        <ViewToggle view={view} onChange={setView} templateCount={templateCount} />
      </div>

      {view === 'templates' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TemplatesView embedded onCount={setTemplateCount} />
        </div>
      ) : (
      /* lg: rows locked to the viewport (minmax(0,1fr)) — an implicit auto row
         would grow with content and clip each pane's bottom (form buttons,
         chat composer) behind the grid's overflow-hidden. */
      <div
        className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden"
        style={{ gridTemplateColumns: `minmax(0,1fr) clamp(${ASSISTANT_WIDTH_MIN}px, ${assistantWidth}px, 50%)` }}
      >
        {/* ── Left pane: activity for the selected agent, or the setup flow ── */}
        <section className="min-w-0 border-b bg-white lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="sticky top-0 z-10 border-b bg-white/80 p-4 backdrop-blur-md supports-[backdrop-filter]:bg-white/70">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                {agents.length > 0 ? (
                  <Select value={selectedAgent?.id ?? ''} onValueChange={selectAgent}>
                    <SelectTrigger className="h-9 font-medium" aria-label="Select agent">
                      <SelectValue placeholder="New agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>{agent.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <h1 className="text-xl font-semibold">{loading ? 'Loading…' : 'Create your first agent'}</h1>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {selectedAgent && isConfigured(selectedAgent) && (
                  <>
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={runningId === selectedAgent.id}
                      onClick={() => runAgent(selectedAgent)}
                      aria-label={`Run ${selectedAgent.title}`}
                      title="Run agent"
                    >
                      {runningId === selectedAgent.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => setConfigureOpen((open) => !open)}
                      aria-label={configureOpen ? 'Back to activity' : 'Configure agent'}
                      title={configureOpen ? 'Back to activity' : 'Configure agent'}
                      className={cn('transition-colors duration-150', configureOpen && 'bg-indigo-50 text-indigo-700')}
                    >
                      {configureOpen ? <List className="h-4 w-4" /> : <Settings2 className="h-4 w-4" />}
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  onClick={() => { setSelectedAgentId(NEW_AGENT); setSetupMode('choice'); setConfigureOpen(false); setFocusRunId(null) }}
                >
                  <Plus className="mr-1.5 h-4 w-4" /> New agent
                </Button>
              </div>
            </div>
          </div>

          {authError && (
            <div className="m-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                {authStatus === 401 ? (
                  <>
                    <p className="font-medium">You’re not signed in.</p>
                    <p className="mb-2 text-amber-800">This environment has no active session — sign in to load your workspace.</p>
                    <Button size="sm" onClick={() => router.push('/auth/login')}>Sign in</Button>
                  </>
                ) : authStatus === 403 ? (
                  <>
                    <p className="font-medium">Your workspace is still provisioning.</p>
                    <p className="text-amber-800">Reload in a moment. If this persists, the database isn’t reachable for this environment.</p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">{authError}</p>
                    <p className="text-amber-800">The database or auth isn’t configured for this environment.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Persistent recommendation surface — a compact collapsible bar that
              renders only when the AI has a suggestion from real usage; each row
              opens a detail popup, and the bell mirrors the same proposals. */}
          {!loading && !authError && (
            <div className="px-4 pt-4">
              <RecommendationsBar />
            </div>
          )}

          {loading && (
            <div className="space-y-3 p-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          )}

          {!loading && showSetup && (
            <div className="space-y-4 p-4">
              {/* Flows-parity first screen: pick a path before any fields show. */}
              {!editingAgent && setupMode === 'choice' && (
                <div className="flex animate-fade-in-up flex-col items-center gap-3 rounded-2xl border bg-white px-8 py-10 text-center shadow-1">
                  <div className="relative">
                    <div aria-hidden="true" className="absolute inset-0 -z-10 scale-[1.8] rounded-full bg-indigo-200/50 blur-2xl" />
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100">
                      <Bot className="h-5 w-5" aria-hidden="true" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">Create your agent</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Describe what it should do and Copilot drafts it for you, or set up the fields yourself.
                    </p>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                    <Button size="sm" onClick={() => setSetupMode('copilot')}>
                      <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
                      Ask Copilot
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSetupMode('manual')}>
                      <Settings2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                      Set up manually
                    </Button>
                  </div>
                </div>
              )}

              {!editingAgent && setupMode === 'copilot' && (
                <div className="animate-fade-in-up">
                  {/* Den-style: describe an agent in plain language and build it. */}
                  <div className="flex items-center gap-2 rounded-xl border bg-gray-50 px-3 py-2 transition-shadow duration-150 focus-within:ring-2 focus-within:ring-indigo-200">
                    <Sparkles className="h-4 w-4 shrink-0 text-indigo-500" />
                    <input
                      className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
                      placeholder={"Describe an agent to build — e.g. “Every Monday, summarize last week’s GitHub activity and post it to Slack”"}
                      value={describe}
                      disabled={building}
                      autoFocus
                      onChange={(event) => setDescribe(event.target.value)}
                      onKeyDown={(event) => event.key === 'Enter' && buildFromDescription()}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={granolaFetchingList || building}
                      onClick={openGranolaPicker}
                      title="Import from Granola"
                      className="shrink-0 gap-1.5 text-xs text-gray-500 hover:text-gray-700"
                    >
                      {granolaFetchingList ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                      Import
                    </Button>
                    <Button size="sm" loading={building} disabled={!describe.trim()} onClick={buildFromDescription}>
                      Build
                    </Button>
                  </div>
                  {/* Granola meeting picker */}
                  {granolaPickerOpen && (
                    <div className="relative mt-1 max-h-64 origin-top animate-scale-in overflow-y-auto rounded-xl border bg-white shadow-popover">
                      <div className="sticky top-0 flex items-center justify-between border-b bg-white px-3 py-2">
                        <span className="text-xs font-medium text-gray-600">Select a meeting to import</span>
                        <button
                          className="rounded p-0.5 text-gray-400 transition-colors duration-150 hover:text-gray-700"
                          onClick={() => setGranolaPickerOpen(false)}
                          aria-label="Close picker"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {granolaFetchingNote && (
                        <div className="flex items-center justify-center p-6 text-sm text-gray-500">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading meeting…
                        </div>
                      )}
                      {!granolaFetchingNote && granolaNotes.length === 0 && (
                        <p className="p-4 text-sm text-gray-500">No recent meetings found in Granola.</p>
                      )}
                      {!granolaFetchingNote && granolaNotes.map((note) => (
                        <button
                          key={note.id}
                          className="flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-gray-50"
                          onClick={() => importGranolaNote(note)}
                        >
                          <span className="truncate text-sm font-medium">{note.title}</span>
                          <span className="truncate text-xs text-gray-400">
                            {note.owner?.name || note.owner?.email || ''}
                            {note.owner && note.created_at ? ' · ' : ''}
                            {note.created_at ? new Date(note.created_at).toLocaleDateString() : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex justify-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSetupMode('manual')}
                      className="gap-1.5 text-xs text-gray-500 hover:text-gray-700"
                    >
                      <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Set up manually instead
                    </Button>
                  </div>
                </div>
              )}

              {editingAgent && !isConfigured(editingAgent) && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Finish setting up this agent to see its activity here.
                </p>
              )}

              {(editingAgent || setupMode === 'manual') && (
              <div className="animate-fade-in-up rounded-lg border bg-white p-4 shadow-1">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="eyebrow">{editingAgent ? 'Agent setup' : 'Set up manually'}</p>
                  {!editingAgent && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSetupMode('copilot')}
                      className="gap-1.5 text-xs text-indigo-600 hover:text-indigo-700"
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      Ask Copilot instead
                    </Button>
                  )}
                </div>
                <AgentConfigForm
                  key={editingAgent?.id || NEW_AGENT}
                  editingAgent={editingAgent}
                  onSave={saveAgent}
                  onRunAgent={editingAgent ? runAgent : undefined}
                  runningId={runningId}
                  onOpenRun={(runId) => { setConfigureOpen(false); setFocusRunId(runId) }}
                />
              </div>
              )}
            </div>
          )}

          {!loading && !showSetup && selectedAgent && (
            <AgentActivityPane
              agent={selectedAgent}
              activities={agentActivities}
              focusRunId={focusRunId}
              onChanged={() => load(true).catch(() => undefined)}
              onSelectRun={setSelectedRun}
            />
          )}

          {!loading && !showSetup && !selectedAgent && agents.length === 0 && (
            <div className="p-4">
              <EmptyState
                icon={Play}
                title="No runs yet"
                description="Create agent and logs will show here"
              />
            </div>
          )}
        </section>

        {/* ── Right pane: persistent assistant chat for the selected agent ── */}
        <section className="relative flex h-[70dvh] min-w-0 flex-col bg-white lg:h-auto lg:min-h-0">
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize assistant panel"
            onMouseDown={onAssistantResizeStart}
            onDoubleClick={resetAssistantWidth}
            title="Drag to resize · double-click to reset"
            className="absolute left-0 top-0 z-20 hidden h-full w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-indigo-200 lg:block"
          />
          <AssistantPanel
            key={selectedAgent?.id ?? 'none'}
            agent={selectedAgent}
            hasFailedRun={hasFailedRun}
            runOutput={runOutput}
            onAgentUpdated={() => load(true).catch(() => undefined)}
            onOpenAgent={(agentId) => {
              // Refresh first: an agent the assistant just created may not be
              // in the polled list yet when the user clicks through to it.
              void load(true).catch(() => undefined)
              setSelectedAgentId(agentId)
              setConfigureOpen(false)
              setFocusRunId(null)
            }}
          />
        </section>
      </div>
      )}
    </div>
  )
}

export default function AgentHQPage() {
  return (
    <Suspense fallback={null}>
      <AgentHQ />
    </Suspense>
  )
}
