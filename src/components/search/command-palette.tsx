'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Bot, Brain, CheckCircle2, CircleDashed, FileText, HelpCircle, KeyRound, Loader2, Plug, Search, Settings, Workflow } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { Agent } from '@/lib/types'

type AgentResult = Pick<Agent, 'id' | 'title' | 'icon' | 'folder'>
type FlowResult = { id: string; name: string; description: string; icon: string; folder: string; status: string }
type RunResult = { id: string; title: string; headline: string | null; status: string; startedAt: string }
type NavResult = { label: string; href: string; icon: LucideIcon }
type Result =
  | { kind: 'nav'; nav: NavResult }
  | { kind: 'agent'; agent: AgentResult }
  | { kind: 'flow'; flow: FlowResult }
  | { kind: 'run'; run: RunResult }

// Mirrors the sidebar's navigation so ⌘K doubles as quick navigation.
const NAV_ITEMS: NavResult[] = [
  { label: 'Home', href: '/dashboard', icon: Brain },
  { label: 'Agents', href: '/agents', icon: Bot },
  { label: 'Flows', href: '/flows', icon: Workflow },
  { label: 'Library', href: '/templates', icon: FileText },
  { label: 'Integrations', href: '/integrations', icon: Plug },
  { label: 'Credentials', href: '/credentials', icon: KeyRound },
  { label: 'Settings', href: '/settings', icon: Settings },
]

function runStatusIcon(status: string) {
  switch (status.toLowerCase()) {
    case 'completed': return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />
    case 'running': return <CircleDashed className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
    case 'waiting_for_input': return <HelpCircle className="h-4 w-4 shrink-0 text-amber-500" />
    default: return <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
  }
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [agents, setAgents] = useState<AgentResult[]>([])
  const [flows, setFlows] = useState<FlowResult[]>([])
  const [runs, setRuns] = useState<RunResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const requestId = useRef(0)

  const navMatches = useMemo<NavResult[]>(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return NAV_ITEMS
    return NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(trimmed))
  }, [query])

  const results = useMemo<Result[]>(() => [
    ...navMatches.map((nav) => ({ kind: 'nav' as const, nav })),
    ...agents.map((agent) => ({ kind: 'agent' as const, agent })),
    ...flows.map((flow) => ({ kind: 'flow' as const, flow })),
    ...runs.map((run) => ({ kind: 'run' as const, run })),
  ], [navMatches, agents, flows, runs])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setAgents([])
      setFlows([])
      setRuns([])
      setActive(0)
      setSearchError(null)
    }
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    const id = ++requestId.current
    if (trimmed.length < 2) {
      setAgents([])
      setFlows([])
      setRuns([])
      setSearching(false)
      setSearchError(null)
      return
    }
    setSearching(true)
    setSearchError(null)
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { cache: 'no-store' })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Workspace search is temporarily unavailable.')
        if (id !== requestId.current) return
        setAgents(data.agents || [])
        setFlows(data.flows || [])
        setRuns(data.runs || [])
        setActive(0)
      } catch (error) {
        if (id === requestId.current) {
          setAgents([])
          setFlows([])
          setRuns([])
          setSearchError(error instanceof Error ? error.message : 'Workspace search is temporarily unavailable.')
        }
      } finally {
        if (id === requestId.current) setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const select = useCallback((result: Result) => {
    onOpenChange(false)
    if (result.kind === 'nav') router.push(result.nav.href)
    else if (result.kind === 'agent') router.push(`/agents?agent=${result.agent.id}`)
    else if (result.kind === 'flow') router.push(`/flows/${result.flow.id}`)
    else router.push(`/agents?run=${result.run.id}`)
  }, [onOpenChange, router])

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault()
      select(results[active])
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[20%] max-w-lg translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Search workspace</DialogTitle>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          {searching ? <Loader2 className="h-4 w-4 animate-spin text-gray-400" /> : <Search className="h-4 w-4 text-gray-400" />}
          <input
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            placeholder="Search navigation, agents, flows, and runs…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="rounded border bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-400">ESC</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2" aria-live="polite" aria-busy={searching}>
          {navMatches.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Navigate</div>
          )}
          {navMatches.map((nav, index) => (
            <button
              key={nav.href}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-fast hover:bg-gray-100', active === index && 'bg-gray-100')}
              onMouseEnter={() => setActive(index)}
              onClick={() => select({ kind: 'nav', nav })}
            >
              <nav.icon className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
              <span className="flex-1 truncate">{nav.label}</span>
            </button>
          ))}
          {agents.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Agents</div>
          )}
          {agents.map((agent, index) => {
            const resultIndex = navMatches.length + index
            return (
            <button
              key={agent.id}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-fast hover:bg-gray-100', active === resultIndex && 'bg-gray-100')}
              onMouseEnter={() => setActive(resultIndex)}
              onClick={() => select({ kind: 'agent', agent })}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-graphite-100 text-[11px] font-semibold uppercase leading-none text-graphite-700">
                {agent.icon || agent.title.trim().charAt(0) || 'A'}
              </span>
              <span className="flex-1 truncate">{agent.title}</span>
              {agent.folder && <span className="text-xs text-gray-400">{agent.folder}</span>}
            </button>
            )
          })}
          {flows.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Flows</div>
          )}
          {flows.map((flow, index) => {
            const resultIndex = navMatches.length + agents.length + index
            return (
              <button
                key={flow.id}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-fast hover:bg-gray-100', active === resultIndex && 'bg-gray-100')}
                onMouseEnter={() => setActive(resultIndex)}
                onClick={() => select({ kind: 'flow', flow })}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-horizon-50 text-horizon-700">
                  {flow.icon ? <span aria-hidden>{flow.icon}</span> : <Workflow className="h-3.5 w-3.5" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{flow.name}</span>
                  {flow.description && <span className="block truncate text-xs text-gray-400">{flow.description}</span>}
                </span>
                <span className="shrink-0 text-[11px] capitalize text-gray-400">{flow.status.toLowerCase()}</span>
              </button>
            )
          })}
          {runs.length > 0 && (
            <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">Runs</div>
          )}
          {runs.map((run, index) => {
            const resultIndex = navMatches.length + agents.length + flows.length + index
            return (
              <button
                key={run.id}
                className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-fast hover:bg-gray-100', active === resultIndex && 'bg-gray-100')}
                onMouseEnter={() => setActive(resultIndex)}
                onClick={() => select({ kind: 'run', run })}
              >
                {runStatusIcon(run.status)}
                <span className="flex-1 truncate">{run.headline || run.title}</span>
                <span className="shrink-0 text-xs text-gray-400">{new Date(run.startedAt).toLocaleDateString()}</span>
              </button>
            )
          })}
          {searchError && !searching && (
            <p className="mx-2 my-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchError}</p>
          )}
          {query.trim().length >= 2 && !searching && !searchError && results.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-gray-500">No results for “{query.trim()}”.</p>
          )}
          {query.trim().length < 2 && (
            <p className="px-2 pb-2 pt-4 text-center text-xs text-gray-400">Choose a destination or type at least 2 characters to search.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
