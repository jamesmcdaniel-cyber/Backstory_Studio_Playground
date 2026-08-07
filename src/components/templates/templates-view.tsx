'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Sparkles, TrendingUp, CalendarClock, ShieldAlert, Target,
  Inbox, LineChart, Bell, Plus, Pencil, Trash2, X, Loader2,
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Pagination, paginate } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import type { WorkspaceConnections } from '@/components/integrations/integration-match'
import { FlowTemplateCard, type FlowTemplateItem } from '@/components/templates/flow-template-card'
import { cn } from '@/lib/utils'

/** Cards per page on the Templates, Flows, and Skills grids. */
const PAGE_SIZE = 9

interface TemplateItem {
  id: string
  name: string
  description: string
  category: string
  instructions?: string
  exampleOutput?: string
  integrations?: string[]
  tags?: string[]
  version?: string
  custom?: boolean
  mine?: boolean
  authorName?: string
}

interface SkillItem {
  id: string
  name: string
  description: string
  category: string
  audience: string[]
  tags: string[]
  integrations: string[]
  instructions?: string
  custom?: boolean
  mine?: boolean
  authorName?: string
}

/** Shared shape for the create/edit dialog across templates and skills. */
type AssetDraft = {
  id?: string
  kind: 'template' | 'skill'
  name: string
  category: string
  description: string
  instructions: string
  tags: string
  integrations: string[]
  exampleOutput: string
}

const emptyAsset = (kind: 'template' | 'skill'): AssetDraft => ({
  kind, name: '', category: kind === 'template' ? 'Custom' : 'Community',
  description: '', instructions: '', tags: '', integrations: [], exampleOutput: '',
})

const csv = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean)

interface AgentItem {
  id: string
  title: string
  skills: string[]
}

// ── Card styling helpers ──────────────────────────────────────────────────
// A small palette of accents; a category is deterministically hashed to one so
// the same category always gets the same color, but cards stay varied and alive.
const ACCENTS = [
  { bar: 'from-sky-500 to-cyan-400',       tile: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',           badge: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',           ring: 'hover:ring-sky-300/70 dark:hover:ring-sky-500/40' },
  { bar: 'from-violet-500 to-fuchsia-400', tile: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', badge: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300', ring: 'hover:ring-violet-300/70 dark:hover:ring-violet-500/40' },
  { bar: 'from-emerald-500 to-teal-400',   tile: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300', ring: 'hover:ring-emerald-300/70 dark:hover:ring-emerald-500/40' },
  { bar: 'from-amber-500 to-orange-400',   tile: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',     badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',     ring: 'hover:ring-amber-300/70 dark:hover:ring-amber-500/40' },
  { bar: 'from-rose-500 to-pink-400',      tile: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',         badge: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',         ring: 'hover:ring-rose-300/70 dark:hover:ring-rose-500/40' },
  { bar: 'from-indigo-500 to-blue-400',    tile: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300', badge: 'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300', ring: 'hover:ring-indigo-300/70 dark:hover:ring-indigo-500/40' },
] as const

function hashIndex(seed: string, mod: number): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return h % mod
}

function accentFor(category: string) {
  return ACCENTS[hashIndex(category || 'default', ACCENTS.length)]
}

function categoryIcon(category: string) {
  const c = (category || '').toLowerCase()
  if (c.includes('meet')) return CalendarClock
  if (c.includes('risk') || c.includes('monitor') || c.includes('contract')) return ShieldAlert
  if (c.includes('forecast')) return LineChart
  if (c.includes('pipeline') || c.includes('discov') || c.includes('opportun')) return Target
  if (c.includes('inbox') || c.includes('productiv') || c.includes('exec')) return Inbox
  if (c.includes('sales') || c.includes('digest') || c.includes('revenue')) return TrendingUp
  if (c.includes('alert') || c.includes('notif') || c.includes('signal')) return Bell
  return Sparkles
}

/**
 * The templates + skills browser. Rendered standalone (its own page header) or
 * `embedded` inside the dashboard behind the Agents/Templates toggle (header
 * suppressed). `onCount` reports the template count up so the toggle can badge
 * it. Sub-tabs (templates/skills) are local state — no route coupling — so it
 * drops into any container.
 */
export function TemplatesView({ embedded = false, onCount }: { embedded?: boolean; onCount?: (count: number) => void }) {
  const [activeTab, setActiveTab] = useState<'templates' | 'flows' | 'skills'>('templates')

  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [flowTemplates, setFlowTemplates] = useState<FlowTemplateItem[]>([])
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // One search box filters whichever tab is active (name/description/category/tags).
  const [search, setSearch] = useState('')
  // AI template finder: same search box, but Enter/"Ask AI" asks the model to
  // match the typed goal against the loaded catalog instead of substring-filtering.
  const [aiResults, setAiResults] = useState<{ id: string; kind: string; reason: string }[] | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  // Card grids cap at 9 per page; each tab pages independently.
  const [templatesPage, setTemplatesPage] = useState(1)
  const [flowsPage, setFlowsPage] = useState(1)
  const [skillsPage, setSkillsPage] = useState(1)
  // Category filter chips (per tab). 'All' shows everything.
  const [category, setCategory] = useState('All')
  // Track which skill's dropdown is open
  const [openSkillMenu, setOpenSkillMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Create/edit dialog for community templates + skills.
  const [dialog, setDialog] = useState<AssetDraft | null>(null)
  const [savingAsset, setSavingAsset] = useState(false)
  // The platform's attachable tools, for the dialog's integration picker.
  // Fetched lazily the first time a dialog opens; null until then.
  const [availableIntegrations, setAvailableIntegrations] = useState<WorkspaceConnections | null>(null)
  const aiRequestSeq = useRef(0)

  useEffect(() => {
    if (dialog === null || availableIntegrations !== null) return
    let cancelled = false
    fetch('/api/integrations/available', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data.success) return
        setAvailableIntegrations({ tools: data.tools ?? [], connections: data.connections ?? [] })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [dialog, availableIntegrations])

  const toggleDialogIntegration = (value: string) => {
    if (!dialog) return
    const next = dialog.integrations.includes(value)
      ? dialog.integrations.filter((i) => i !== value)
      : [...dialog.integrations, value]
    setDialog({ ...dialog, integrations: next })
  }

  const openCreate = (kind: 'template' | 'skill') => setDialog(emptyAsset(kind))
  const openEditTemplate = (t: TemplateItem) =>
    setDialog({
      id: t.id, kind: 'template', name: t.name, category: t.category, description: t.description,
      instructions: t.instructions ?? '', tags: (t.tags ?? []).join(', '), integrations: t.integrations ?? [],
      exampleOutput: t.exampleOutput ?? '',
    })
  const openEditSkill = (s: SkillItem) =>
    setDialog({
      id: s.id, kind: 'skill', name: s.name, category: s.category, description: s.description,
      instructions: s.instructions ?? '', tags: (s.tags ?? []).join(', '), integrations: s.integrations ?? [],
      exampleOutput: '',
    })

  const saveAsset = async () => {
    if (!dialog || !dialog.name.trim() || !dialog.instructions.trim()) {
      toast.error('Name and instructions are required.')
      return
    }
    setSavingAsset(true)
    const url = dialog.kind === 'template' ? '/api/agent-templates' : '/api/skills'
    const payload =
      dialog.kind === 'template'
        ? { name: dialog.name, category: dialog.category, description: dialog.description, instructions: dialog.instructions, tags: csv(dialog.tags), integrations: dialog.integrations, exampleOutput: dialog.exampleOutput || undefined }
        : { name: dialog.name, category: dialog.category, description: dialog.description, instructions: dialog.instructions, tags: csv(dialog.tags), integrations: dialog.integrations }
    try {
      const res = await fetch(url, {
        method: dialog.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Saving only ever creates a WORKSPACE asset. Reaching the shared
        // catalogue is a separate, reviewed step — the server ignores any
        // visibility a client sends, so sending one here would only mislead.
        body: JSON.stringify(dialog.id ? { id: dialog.id, ...payload } : payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Save failed')
      // Refetch so the new/edited card shows immediately.
      if (dialog.kind === 'template') {
        const list = await fetch('/api/agent-templates', { cache: 'no-store' }).then((r) => r.json())
        setTemplates(list.templates || [])
      } else {
        const list = await fetch('/api/skills', { cache: 'no-store' }).then((r) => r.json())
        setSkills(list.success ? list.skills : [])
      }
      toast.success(dialog.id ? 'Saved' : 'Saved to your workspace')
      setDialog(null)
    } catch (e: any) {
      toast.error(e?.message || 'Could not save')
    } finally {
      setSavingAsset(false)
    }
  }

  const deleteAsset = async (kind: 'template' | 'skill', id: string, name: string) => {
    if (!confirm(`Remove "${name}" from your workspace?`)) return
    const url = kind === 'template' ? '/api/agent-templates' : '/api/skills'
    const res = await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    if (res.ok) {
      if (kind === 'template') setTemplates((prev) => prev.filter((t) => t.id !== id))
      else setSkills((prev) => prev.filter((s) => s.id !== id))
      toast.success('Removed')
    } else toast.error('Could not remove')
  }

  const handleTabChange = (value: string) => {
    // Categories differ per tab, so a filter from one tab shouldn't linger.
    setCategory('All')
    setActiveTab(value === 'skills' ? 'skills' : value === 'flows' ? 'flows' : 'templates')
  }

  const deleteFlowTemplate = async (template: FlowTemplateItem) => {
    if (!confirm(`Remove "${template.name}" from the flow library?`)) return
    const res = await fetch('/api/flow-templates', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: template.id }),
    })
    if (!res.ok) {
      toast.error('Could not remove')
      return
    }
    setFlowTemplates((prev) => prev.filter((entry) => entry.id !== template.id))
    toast.success('Removed')
  }

  // Report the template count up (for the dashboard toggle badge) whenever it
  // changes — initial load, create, or delete.
  useEffect(() => { onCount?.(templates.length) }, [templates, onCount])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [templatesRes, flowsRes, skillsRes, agentsRes] = await Promise.all([
          fetch('/api/agent-templates', { cache: 'no-store' }),
          fetch('/api/flow-templates', { cache: 'no-store' }),
          fetch('/api/skills', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
        ])
        if (!templatesRes.ok) throw new Error(`Templates fetch failed: status ${templatesRes.status}`)
        const [templatesData, flowsData, skillsData, agentsData] = await Promise.all([
          templatesRes.json(),
          flowsRes.ok ? flowsRes.json() : { success: false, templates: [] },
          skillsRes.ok ? skillsRes.json() : { success: false, skills: [] },
          agentsRes.ok ? agentsRes.json() : { success: false, agents: [] },
        ])
        if (cancelled) return
        setTemplates(templatesData.templates || [])
        // Flatten to the card shape here: the wire payload carries the whole
        // graph and notes, which the grid has no use for.
        setFlowTemplates(
          (flowsData.templates || []).map((entry: Record<string, any>): FlowTemplateItem => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            icon: entry.icon,
            integrations: entry.integrations,
            tags: entry.tags,
            stepCount: entry.stepCount ?? 0,
            setupCount: (entry.bindings?.length ?? 0) + (entry.notes?.setup?.length ?? 0),
            custom: entry.custom,
            mine: entry.mine,
            source: entry.source,
          })),
        )
        setSkills(skillsData.success ? skillsData.skills : [])
        setAgents(agentsData.success ? agentsData.agents : [])
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load templates')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!openSkillMenu) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenSkillMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openSkillMenu])

  // Search filter across name, description, category, and tags.
  const q = search.trim().toLowerCase()
  const matches = (item: { name: string; description: string; category: string; tags?: string[] }) =>
    !q || `${item.name} ${item.description} ${item.category} ${(item.tags || []).join(' ')}`.toLowerCase().includes(q)
  const inCategory = (item: { category: string }) => category === 'All' || item.category === category
  // Category chips are derived from the active tab's real categories (sorted,
  // deduped) — so they always reflect what's actually in the library.
  const categoriesFor = (items: { category: string }[]) =>
    ['All', ...Array.from(new Set(items.map((i) => i.category).filter(Boolean))).sort()]
  const activeCategories = categoriesFor(activeTab === 'skills' ? skills : activeTab === 'flows' ? flowTemplates : templates)
  const filteredTemplates = templates.filter(matches).filter(inCategory)
  const filteredFlowTemplates = flowTemplates.filter(matches).filter(inCategory)
  const filteredSkills = skills.filter(matches).filter(inCategory)

  const onSearch = (value: string) => {
    setSearch(value)
    setTemplatesPage(1)
    setFlowsPage(1)
    setSkillsPage(1)
  }

  const onCategory = (value: string) => {
    setCategory(value)
    setTemplatesPage(1)
    setFlowsPage(1)
    setSkillsPage(1)
  }

  // Asks the model to match the typed goal against the already-loaded catalog.
  // Setting aiResults to [] immediately (rather than leaving it null) opens the
  // suggestions section right away so the loading spinner has somewhere to render.
  const runAiSearch = async () => {
    const goal = search.trim()
    if (goal.length < 3 || aiLoading) return
    const seq = ++aiRequestSeq.current
    setAiResults([])
    setAiError(null)
    setAiLoading(true)
    try {
      const items = [
        ...templates.map((t) => ({ id: t.id, kind: 'template' as const, name: t.name, description: t.description, category: t.category, tags: t.tags })),
        ...skills.map((s) => ({ id: s.id, kind: 'skill' as const, name: s.name, description: s.description, category: s.category, tags: s.tags })),
      ]
      const res = await fetch('/api/templates/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: goal, items }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (seq === aiRequestSeq.current) setAiError(data.error || 'Could not find matches for that goal.')
        return
      }
      if (seq === aiRequestSeq.current) setAiResults(data.matches || [])
    } catch {
      if (seq === aiRequestSeq.current) setAiError('Could not find matches for that goal.')
    } finally {
      if (seq === aiRequestSeq.current) setAiLoading(false)
    }
  }

  const closeAiResults = () => {
    aiRequestSeq.current++
    setAiResults(null)
    setAiError(null)
    setAiLoading(false)
  }

  const jumpToMatch = (match: { id: string; kind: string }, name: string) => {
    handleTabChange(match.kind === 'skill' ? 'skills' : 'templates')
    onSearch(name)
  }

  const addSkillToAgent = async (skill: SkillItem, agent: AgentItem) => {
    setOpenSkillMenu(null)
    const updatedSkills = Array.from(new Set([...(agent.skills || []), skill.id]))
    try {
      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id, skills: updatedSkills }),
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      // Update local agent list so subsequent "add" operations see the latest skills
      setAgents((prev) =>
        prev.map((a) => a.id === agent.id ? { ...a, skills: updatedSkills } : a)
      )
      toast.success(`Added "${skill.name}" to ${agent.title}`)
    } catch {
      toast.error(`Failed to add skill to ${agent.title}`)
    }
  }

  // Attach the skill to every agent at once.
  const addSkillToAllAgents = async (skill: SkillItem) => {
    setOpenSkillMenu(null)
    const results = await Promise.all(
      agents.map(async (agent) => {
        const updatedSkills = Array.from(new Set([...(agent.skills || []), skill.id]))
        const res = await fetch('/api/agents', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: agent.id, skills: updatedSkills }),
        }).catch(() => null)
        return { agent, ok: Boolean(res?.ok), updatedSkills }
      }),
    )
    const succeeded = results.filter((r) => r.ok)
    setAgents((prev) =>
      prev.map((a) => {
        const hit = succeeded.find((r) => r.agent.id === a.id)
        return hit ? { ...a, skills: hit.updatedSkills } : a
      }),
    )
    if (succeeded.length === results.length) toast.success(`Added "${skill.name}" to all ${succeeded.length} agents`)
    else toast.error(`Added to ${succeeded.length} of ${results.length} agents — some failed`)
  }

  if (loading || error) {
    return (
      <>
        <div className="max-w-6xl mx-auto p-6 space-y-6">
          {!embedded && <PageHeader eyebrow="Library" title="Templates" />}
          {loading && (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
              <Skeleton className="h-56 rounded-xl" />
            </div>
          )}
          {error && <p className="text-red-500">{error}</p>}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {!embedded && <PageHeader eyebrow="Library" title="Templates" />}

        <div className="relative w-full">
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runAiSearch()
            }}
            placeholder="Describe what you want to accomplish — press Enter for AI matches…"
            className="h-11 w-full pr-28"
          />
          <button
            type="button"
            disabled={search.trim().length < 3 || aiLoading}
            onClick={runAiSearch}
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700 disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {aiLoading ? 'Asking…' : 'Ask AI'}
          </button>
        </div>

        {aiResults !== null && (
          <div className="space-y-3 rounded-xl border border-indigo-200/60 bg-indigo-50/40 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-indigo-600 dark:text-indigo-300" />
                <h3 className="text-sm font-semibold">AI suggestions</h3>
              </div>
              <button
                type="button"
                aria-label="Dismiss AI suggestions"
                onClick={closeAiResults}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {aiLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Finding templates for your goal…
              </div>
            ) : aiError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{aiError}</p>
            ) : aiResults.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No templates match that goal yet."
                description="You can create one."
                action={
                  <Button size="sm" onClick={() => openCreate(activeTab === 'skills' ? 'skill' : 'template')}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    {activeTab === 'skills' ? 'Create skill' : 'Create template'}
                  </Button>
                }
              />
            ) : (
              <div className="space-y-2">
                {aiResults.map((match) => {
                  const item =
                    match.kind === 'skill'
                      ? skills.find((s) => s.id === match.id)
                      : templates.find((t) => t.id === match.id)
                  if (!item) return null
                  return (
                    <div
                      key={`${match.kind}-${match.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card p-3"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{item.name}</span>
                          <Badge variant="outline" className="text-[11px]">{item.category}</Badge>
                        </div>
                        <p className="text-xs italic text-muted-foreground">{match.reason}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => jumpToMatch(match, item.name)}>
                        View
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="flows">Flows</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
          </TabsList>

          {/* Category filter — derived from the active tab's real categories. */}
          {activeCategories.length > 2 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {activeCategories.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onCategory(c)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    category === c
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300'
                      : 'border-border/70 text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {/* ── Templates tab ─────────────────────────────────────────────── */}
          <TabsContent value="templates" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold">Templates</h2>
                <p className="text-sm text-muted-foreground">Built-in + community templates. Yours are shared publicly.</p>
              </div>
              <Button size="sm" onClick={() => openCreate('template')}><Plus className="mr-1.5 h-4 w-4" /> Create template</Button>
            </div>

            {filteredTemplates.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No templates available yet"
                description="Templates published to your workspace appear here."
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginate(filteredTemplates, templatesPage, PAGE_SIZE).pageItems.map((t) => {
                  const accent = accentFor(t.category)
                  const Icon = categoryIcon(t.category)
                  return (
                    <Link key={t.id} href={`/templates/${t.id}`} className="block">
                      <Card variant="interactive" className={cn(
                        'group relative h-full overflow-hidden border-border/60 hover:ring-1',
                        accent.ring,
                      )}>
                        {/* colored accent bar that brightens on hover */}
                        <div className={cn('absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                        {t.mine && (
                          <div className="absolute right-2 top-2 z-10 hidden gap-1 group-hover:flex">
                            <button type="button" aria-label="Edit template" onClick={(e) => { e.preventDefault(); openEditTemplate(t) }} className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-indigo-600"><Pencil className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label="Delete template" onClick={(e) => { e.preventDefault(); deleteAsset('template', t.id, t.name) }} className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        )}
                        <CardHeader className="space-y-2.5 pt-5">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{t.category}</Badge>
                            {t.custom && <Badge variant="outline" className="text-[11px] font-medium border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">Community</Badge>}
                          </div>
                          <div className="flex items-start gap-2.5">
                            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
                              <Icon className="h-[18px] w-[18px]" />
                            </span>
                            <CardTitle className="min-w-0 text-base leading-snug">{t.name}</CardTitle>
                          </div>
                          {t.tags && t.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {t.tags.slice(0, 3).map(tag => (
                                <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">{tag}</Badge>
                              ))}
                            </div>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <p className="text-sm text-muted-foreground line-clamp-3">{t.description}</p>
                          {t.integrations && t.integrations.length > 0 && (
                            <div className="space-y-1.5">
                              <p className="text-xs font-medium text-muted-foreground">Requires</p>
                              <div className="flex flex-wrap gap-1.5">
                                {t.integrations.map((i) => (
                                  <IntegrationChip key={i} name={i} />
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="flex items-center gap-1 pt-1 text-sm font-medium text-indigo-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-indigo-300">
                            Use template
                            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  )
                })}
              </div>
            )}
            <Pagination
              page={paginate(filteredTemplates, templatesPage, PAGE_SIZE).page}
              pageCount={paginate(filteredTemplates, templatesPage, PAGE_SIZE).pageCount}
              onPageChange={setTemplatesPage}
            />
          </TabsContent>

          {/* ── Flows tab ─────────────────────────────────────────────────── */}
          <TabsContent value="flows" className="mt-6">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Flow templates</h2>
                <p className="text-sm text-muted-foreground">
                  Complete pipelines, wired and explained step by step. Use one and it lands as a draft you can read before it runs.
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href="/flows">Open Flows</Link>
              </Button>
            </div>

            {filteredFlowTemplates.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No flow templates match"
                description="Clear the search or category filter, or save one of your own flows as a template from its builder."
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {paginate(filteredFlowTemplates, flowsPage, PAGE_SIZE).pageItems.map((template) => (
                  <FlowTemplateCard
                    key={template.id}
                    template={template}
                    accent={accentFor(template.category)}
                    onDelete={deleteFlowTemplate}
                  />
                ))}
              </div>
            )}
            <Pagination
              page={paginate(filteredFlowTemplates, flowsPage, PAGE_SIZE).page}
              pageCount={paginate(filteredFlowTemplates, flowsPage, PAGE_SIZE).pageCount}
              onPageChange={setFlowsPage}
            />
          </TabsContent>

          {/* ── Skills tab ────────────────────────────────────────────────── */}
          <TabsContent value="skills" className="mt-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold">Skills</h2>
                <p className="text-sm text-muted-foreground">Instruction packs that extend agents at run time. Yours are shared publicly.</p>
              </div>
              <Button size="sm" onClick={() => openCreate('skill')}><Plus className="mr-1.5 h-4 w-4" /> Create skill</Button>
            </div>

            {filteredSkills.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="No skills available yet"
                description="Skills published to your workspace appear here."
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginate(filteredSkills, skillsPage, PAGE_SIZE).pageItems.map((skill) => {
                  const accent = accentFor(skill.category)
                  const Icon = categoryIcon(skill.category)
                  return (
                  // overflow stays visible so the add-to-agent menu isn't clipped
                  <Card key={skill.id} variant="interactive" className={cn(
                    'group relative flex h-full flex-col border-border/60 hover:ring-1',
                    accent.ring,
                  )}>
                    <div className={cn('absolute inset-x-0 top-0 h-1 rounded-t-xl bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                    {skill.mine && (
                      <div className="absolute right-2 top-2 z-10 hidden gap-1 group-hover:flex">
                        <button type="button" aria-label="Edit skill" onClick={() => openEditSkill(skill)} className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-indigo-600"><Pencil className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label="Delete skill" onClick={() => deleteAsset('skill', skill.id, skill.name)} className="rounded-md border bg-card p-1.5 text-muted-foreground shadow-1 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    )}
                    <CardHeader className="space-y-2.5 pt-5">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{skill.category}</Badge>
                        {skill.custom && <Badge variant="outline" className="text-[11px] font-medium border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">Community</Badge>}
                      </div>
                      <div className="flex items-start gap-2.5">
                        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', accent.tile)}>
                          <Icon className="h-[18px] w-[18px]" />
                        </span>
                        <CardTitle className="min-w-0 text-base leading-snug">{skill.name}</CardTitle>
                      </div>
                      {skill.tags && skill.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">{tag}</Badge>
                          ))}
                        </div>
                      )}
                    </CardHeader>
                    <CardContent className="flex flex-col flex-1 space-y-3">
                      <p className="text-sm text-muted-foreground line-clamp-3 flex-1">{skill.description}</p>

                      {skill.integrations && skill.integrations.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {skill.integrations.map((i) => (
                            <IntegrationChip key={i} name={i} />
                          ))}
                        </div>
                      )}

                      {/* Add to agent control */}
                      <div className="relative" ref={openSkillMenu === skill.id ? menuRef : null}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full"
                          onClick={() => {
                            if (agents.length === 0) {
                              toast('Create an agent first before adding skills.')
                              return
                            }
                            setOpenSkillMenu(openSkillMenu === skill.id ? null : skill.id)
                          }}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" />
                          Add to agent
                        </Button>

                        {openSkillMenu === skill.id && agents.length > 0 && (
                          <div className="absolute bottom-full left-0 right-0 mb-1 z-50 origin-bottom animate-scale-in rounded-md border border-border bg-popover shadow-popover">
                            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground font-medium">Select an agent</p>
                            <button
                              type="button"
                              className="w-full px-3 py-2 text-left text-sm font-medium text-indigo-600 hover:bg-accent transition-colors"
                              onClick={() => addSkillToAllAgents(skill)}
                            >
                              All agents ({agents.length})
                            </button>
                            <div className="mx-3 border-t" />
                            <ul className="max-h-48 overflow-y-auto pb-1">
                              {agents.map((agent) => (
                                <li key={agent.id}>
                                  <button
                                    type="button"
                                    className="w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
                                    onClick={() => addSkillToAgent(skill, agent)}
                                  >
                                    {agent.title}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  )
                })}
              </div>
            )}
            <Pagination
              page={paginate(filteredSkills, skillsPage, PAGE_SIZE).page}
              pageCount={paginate(filteredSkills, skillsPage, PAGE_SIZE).pageCount}
              onPageChange={setSkillsPage}
            />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialog?.id ? 'Edit' : 'Create'} {dialog?.kind === 'skill' ? 'skill' : 'template'}
            </DialogTitle>
          </DialogHeader>
          {dialog && (
            /* Negative margin + matching padding gives input focus rings room
               to render inside the scroll clip instead of being cut at its edges. */
            <div className="-mx-1 max-h-[65vh] space-y-3 overflow-y-auto px-1 py-1">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
                  <Input value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} placeholder="e.g. Concise email replies" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
                  <Input value={dialog.category} onChange={(e) => setDialog({ ...dialog, category: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
                <Input value={dialog.description} onChange={(e) => setDialog({ ...dialog, description: e.target.value })} placeholder="One line shown on the card" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {dialog.kind === 'skill' ? 'Skill instructions (composed into the agent prompt)' : 'Agent instructions'}
                </label>
                <Textarea rows={8} value={dialog.instructions} onChange={(e) => setDialog({ ...dialog, instructions: e.target.value })} placeholder="What the agent should do…" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Tags (comma-separated)</label>
                <Input value={dialog.tags} onChange={(e) => setDialog({ ...dialog, tags: e.target.value })} placeholder="sales, email" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Integrations</label>
                {availableIntegrations ? (
                  <div className="flex flex-wrap gap-2">
                    {availableIntegrations.tools.map((t) => {
                      const selected = dialog.integrations.includes(t.key)
                      return (
                        <button
                          key={t.key}
                          type="button"
                          onClick={() => toggleDialogIntegration(t.key)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                          )}
                        >
                          <IntegrationLogo slug={t.slug} name={t.label} className="h-4 w-4 bg-white/70" />
                          {t.label}
                        </button>
                      )
                    })}
                    {availableIntegrations.connections.map((c) => {
                      const selected = dialog.integrations.includes(c.name)
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => toggleDialogIntegration(c.name)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-full border py-1 pl-1.5 pr-3 text-xs transition-colors duration-150',
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-transparent text-muted-foreground hover:border-primary hover:text-foreground',
                          )}
                        >
                          <IntegrationLogo slug={c.name.toLowerCase().replace(/[^a-z0-9]+/g, '')} name={c.name} className="h-4 w-4 bg-white/70" />
                          {c.name}
                        </button>
                      )
                    })}
                    {/* Integrations saved before the picker existed (or from a
                        removed tool) stay visible so they can be deselected. */}
                    {dialog.integrations
                      .filter((name) =>
                        !availableIntegrations.tools.some((t) => t.key === name) &&
                        !availableIntegrations.connections.some((c) => c.name === name))
                      .map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => toggleDialogIntegration(name)}
                          className="flex items-center gap-1.5 rounded-full border border-primary bg-primary py-1 pl-3 pr-2 text-xs text-primary-foreground transition-colors duration-150"
                        >
                          {name}
                          <X className="h-3 w-3" />
                        </button>
                      ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Skeleton className="h-7 w-24 rounded-full" />
                    <Skeleton className="h-7 w-20 rounded-full" />
                    <Skeleton className="h-7 w-28 rounded-full" />
                  </div>
                )}
              </div>
              {dialog.kind === 'template' && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Example output (optional)</label>
                  <Textarea rows={3} value={dialog.exampleOutput} onChange={(e) => setDialog({ ...dialog, exampleOutput: e.target.value })} placeholder="Illustrative output shown on the detail page" />
                </div>
              )}
              <p className="text-xs text-muted-foreground">Saved to your workspace. To offer it to every workspace, send it to Backstory for review from its card.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={saveAsset} loading={savingAsset}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
