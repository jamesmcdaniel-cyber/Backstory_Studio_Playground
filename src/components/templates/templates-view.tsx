'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import {
  Sparkles, TrendingUp, CalendarClock, ShieldAlert, Target,
  Inbox, LineChart, Bell, Plus, Pencil, Trash2, X,
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
import { HtmlPreview, looksLikeHtml, unwrapHtmlFence } from '@/components/ui/html-preview'
import { ConfirmDialog } from '@/components/settings/dialogs'
import type { WorkspaceConnections } from '@/components/integrations/integration-match'
import { accentFor } from '@/components/templates/accents'
import { LibraryFilterBar, ALL_FILTER } from '@/components/templates/library-filter-bar'
import { hasRole } from '@/lib/templates/roles'
import { cn } from '@/lib/utils'

/** Cards per page on the Templates and Skills grids. */
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
// Accent recipes live in ./accents — shared with the Flows-page template
// gallery so a category keeps its color across both surfaces.
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

/** The canonical templates + skills browser at /templates. */
export function TemplatesView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeTab, setActiveTab] = useState<'templates' | 'skills'>(() => searchParams.get('asset') === 'skills' ? 'skills' : 'templates')

  const [templates, setTemplates] = useState<TemplateItem[]>([])
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [agents, setAgents] = useState<AgentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // One search box filters whichever tab is active (name/description/category/tags).
  const [search, setSearch] = useState(() => searchParams.get('q') || '')
  // Card grids cap at 9 per page; each tab pages independently.
  const [templatesPage, setTemplatesPage] = useState(1)
  const [skillsPage, setSkillsPage] = useState(1)
  // Category is per tab (the two vocabularies differ); role spans both, since a
  // CSM looking for their work wants it whether it ships as a template or a skill.
  const [category, setCategory] = useState(() => searchParams.get('category') || ALL_FILTER)
  const [role, setRole] = useState(() => searchParams.get('role') || ALL_FILTER)
  // Track which skill's dropdown is open
  const [openSkillMenu, setOpenSkillMenu] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Create/edit dialog for community templates + skills.
  const [dialog, setDialog] = useState<AssetDraft | null>(null)
  const [savingAsset, setSavingAsset] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'template' | 'skill'; id: string; name: string } | null>(null)
  const [deletingAsset, setDeletingAsset] = useState(false)
  // The platform's attachable tools, for the dialog's integration picker.
  // Fetched lazily the first time a dialog opens; null until then.
  const [availableIntegrations, setAvailableIntegrations] = useState<WorkspaceConnections | null>(null)
  // Write/Preview toggle for the dialog's example-output field. Reset whenever
  // a different asset is opened so a stale preview never greets a new draft.
  const [previewExample, setPreviewExample] = useState(false)

  useEffect(() => { setPreviewExample(false) }, [dialog?.id, dialog?.kind])

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

  const deleteAsset = async (kind: 'template' | 'skill', id: string) => {
    setDeletingAsset(true)
    const url = kind === 'template' ? '/api/agent-templates' : '/api/skills'
    try {
      const res = await fetch(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not remove the item.')
      if (kind === 'template') setTemplates((prev) => prev.filter((t) => t.id !== id))
      else setSkills((prev) => prev.filter((s) => s.id !== id))
      setDeleteTarget(null)
      toast.success('Removed from workspace')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the item.')
    } finally {
      setDeletingAsset(false)
    }
  }

  const handleTabChange = (value: string) => {
    // Categories differ per tab, so a filter from one tab shouldn't linger.
    // Role is the same taxonomy on both sides, so it deliberately does.
    setCategory(ALL_FILTER)
    setActiveTab(value === 'skills' ? 'skills' : 'templates')
  }

  // Standalone Library URLs retain the active collection and filters, making a
  // refined view shareable and preserving context when a detail page is closed.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams()
      if (activeTab === 'skills') params.set('asset', 'skills')
      if (search.trim()) params.set('q', search.trim())
      if (category !== ALL_FILTER) params.set('category', category)
      if (role !== ALL_FILTER) params.set('role', role)
      const queryString = params.toString()
      router.replace(queryString ? `/templates?${queryString}` : '/templates', { scroll: false })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [activeTab, category, role, router, search])

  useEffect(() => {
    const restoreFromHistory = () => {
      const params = new URLSearchParams(window.location.search)
      setActiveTab(params.get('asset') === 'skills' ? 'skills' : 'templates')
      setSearch(params.get('q') || '')
      setCategory(params.get('category') || ALL_FILTER)
      setRole(params.get('role') || ALL_FILTER)
      setTemplatesPage(1)
      setSkillsPage(1)
    }
    window.addEventListener('popstate', restoreFromHistory)
    return () => window.removeEventListener('popstate', restoreFromHistory)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [templatesRes, skillsRes, agentsRes] = await Promise.all([
          fetch('/api/agent-templates', { cache: 'no-store' }),
          fetch('/api/skills', { cache: 'no-store' }),
          fetch('/api/agents', { cache: 'no-store' }),
        ])
        if (!templatesRes.ok) throw new Error(`Templates fetch failed: status ${templatesRes.status}`)
        const [templatesData, skillsData, agentsData] = await Promise.all([
          templatesRes.json(),
          skillsRes.ok ? skillsRes.json() : { success: false, skills: [] },
          agentsRes.ok ? agentsRes.json() : { success: false, agents: [] },
        ])
        if (cancelled) return
        setTemplates(templatesData.templates || [])
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
  const inCategory = (item: { category: string }) => category === ALL_FILTER || item.category === category
  // A skill states its audience; a template has only its category and tags —
  // hasRole reads whichever the item carries.
  const inRole = (item: { category: string; tags?: string[]; audience?: string[] }) => hasRole(item, role)
  // The Category dropdown is derived from the active tab's real categories
  // (sorted, deduped) — so it always reflects what's actually in the library.
  const categoriesFor = (items: { category: string }[]) =>
    Array.from(new Set(items.map((i) => i.category).filter(Boolean))).sort()
  const activeCategories = categoriesFor(activeTab === 'skills' ? skills : templates)
  const filteredTemplates = templates.filter(matches).filter(inCategory).filter(inRole)
  const filteredSkills = skills.filter(matches).filter(inCategory).filter(inRole)

  // Any filter change returns both grids to page one — otherwise a narrower
  // result set leaves you on a page that no longer exists.
  const resetPages = () => { setTemplatesPage(1); setSkillsPage(1) }
  const onSearch = (value: string) => { setSearch(value); resetPages() }
  const onCategory = (value: string) => { setCategory(value); resetPages() }
  const onRole = (value: string) => { setRole(value); resetPages() }

  // An empty grid means two different things — nothing published yet, or
  // nothing left after filtering — and only one of them has a way out.
  const filtering = q !== '' || category !== ALL_FILTER || role !== ALL_FILTER
  const clearFilters = () => { setSearch(''); setCategory(ALL_FILTER); setRole(ALL_FILTER); resetPages() }

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
        <div className="space-y-6">
          <PageHeader eyebrow="Workspace" title="Library" />
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
      <div className="space-y-6">
        <PageHeader eyebrow="Workspace" title="Library" />

        {/* One simple search box plus two dropdowns — the same bar the flow
            gallery uses, so the two libraries filter identically. */}
        <LibraryFilterBar
          search={search}
          onSearchChange={onSearch}
          searchLabel="Search templates and skills"
          categories={activeCategories}
          category={category}
          onCategoryChange={onCategory}
          role={role}
          onRoleChange={onRole}
        />

        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList>
            {/* Counts here are the unfiltered totals, so the two add up to the
                number on the dashboard's Templates badge. */}
            <TabsTrigger value="templates">Templates ({templates.length})</TabsTrigger>
            <TabsTrigger value="skills">Skills ({skills.length})</TabsTrigger>
          </TabsList>

          {/* ── Templates tab ─────────────────────────────────────────────── */}
          <TabsContent value="templates" className="mt-6">
            <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-semibold">Templates</h2>
                <p className="text-sm text-muted-foreground">Built-in, community, and workspace templates. Items you create stay in this workspace.</p>
              </div>
              <Button size="sm" onClick={() => openCreate('template')}><Plus className="mr-1.5 h-4 w-4" /> Create template</Button>
            </div>

            {filteredTemplates.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title={filtering ? 'No templates match those filters' : 'No templates available yet'}
                description={
                  filtering
                    ? 'Try another search term, category, or role.'
                    : 'Templates published to your workspace appear here.'
                }
                action={filtering ? <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button> : undefined}
              />
            ) : (
              <div className="stagger-children grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {paginate(filteredTemplates, templatesPage, PAGE_SIZE).pageItems.map((t) => {
                  const accent = accentFor(t.category)
                  const Icon = categoryIcon(t.category)
                  return (
                    <Card key={t.id} variant="interactive" className={cn(
                      'group relative h-full overflow-hidden border-border/60 hover:ring-1',
                      accent.ring,
                    )}>
                        {/* colored accent bar that brightens on hover */}
                        <div className={cn('absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r opacity-80 transition-opacity group-hover:opacity-100', accent.bar)} />
                        {t.mine && (
                          <div className="absolute right-2 top-2 z-20 flex gap-1 opacity-75 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                            <button type="button" aria-label={`Edit ${t.name}`} onClick={() => openEditTemplate(t)} className="flex h-8 w-8 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-1 hover:text-indigo-600"><Pencil className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label={`Delete ${t.name}`} onClick={() => setDeleteTarget({ kind: 'template', id: t.id, name: t.name })} className="flex h-8 w-8 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-1 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        )}
                        <Link href={`/templates/${t.id}`} className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                        <CardHeader className="space-y-2.5 pt-5">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{t.category}</Badge>
                            {t.custom && <Badge variant="outline" className="text-[11px] font-medium border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">{t.mine ? 'Workspace' : 'Community'}</Badge>}
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
                          <div className="flex items-center gap-1 pt-1 text-sm font-medium text-indigo-600 dark:text-indigo-300">
                            View template
                            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
                          </div>
                        </CardContent>
                        </Link>
                      </Card>
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

          {/* ── Skills tab ────────────────────────────────────────────────── */}
          <TabsContent value="skills" className="mt-6">
            <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-lg font-semibold">Skills</h2>
                <p className="text-sm text-muted-foreground">Reusable instruction packs for agents. Skills you create stay in this workspace.</p>
              </div>
              <Button size="sm" onClick={() => openCreate('skill')}><Plus className="mr-1.5 h-4 w-4" /> Create skill</Button>
            </div>

            {filteredSkills.length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title={filtering ? 'No skills match those filters' : 'No skills available yet'}
                description={
                  filtering
                    ? 'Try another search term, category, or role.'
                    : 'Skills published to your workspace appear here.'
                }
                action={filtering ? <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button> : undefined}
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
                      <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-75 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <button type="button" aria-label={`Edit ${skill.name}`} onClick={() => openEditSkill(skill)} className="flex h-8 w-8 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-1 hover:text-indigo-600"><Pencil className="h-3.5 w-3.5" /></button>
                        <button type="button" aria-label={`Delete ${skill.name}`} onClick={() => setDeleteTarget({ kind: 'skill', id: skill.id, name: skill.name })} className="flex h-8 w-8 items-center justify-center rounded-md border bg-card text-muted-foreground shadow-1 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    )}
                    <CardHeader className="space-y-2.5 pt-5">
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className={cn('text-[11px] font-medium', accent.badge)}>{skill.category}</Badge>
                        {skill.custom && <Badge variant="outline" className="text-[11px] font-medium border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">{skill.mine ? 'Workspace' : 'Community'}</Badge>}
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
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-name">Name</label>
                  <Input id="template-dialog-name" value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} placeholder="e.g. Concise email replies" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-category">Category</label>
                  <Input id="template-dialog-category" value={dialog.category} onChange={(e) => setDialog({ ...dialog, category: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-description">Description</label>
                <Input id="template-dialog-description" value={dialog.description} onChange={(e) => setDialog({ ...dialog, description: e.target.value })} placeholder="One line shown on the card" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-instructions">
                  {dialog.kind === 'skill' ? 'Skill instructions (composed into the agent prompt)' : 'Agent instructions'}
                </label>
                <Textarea id="template-dialog-instructions" rows={8} value={dialog.instructions} onChange={(e) => setDialog({ ...dialog, instructions: e.target.value })} placeholder="What the agent should do…" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-tags">Tags (comma-separated)</label>
                <Input id="template-dialog-tags" value={dialog.tags} onChange={(e) => setDialog({ ...dialog, tags: e.target.value })} placeholder="sales, email" />
              </div>
              <div>
                <span id="template-dialog-integrations" className="mb-1 block text-xs font-medium text-muted-foreground">Integrations</span>
                {availableIntegrations ? (
                  <div role="group" aria-labelledby="template-dialog-integrations" className="flex flex-wrap gap-2">
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
                  <div className="mb-1 flex items-center justify-between">
                    <label className="block text-xs font-medium text-muted-foreground" htmlFor="template-dialog-example-output">Example output (optional)</label>
                    {dialog.exampleOutput.trim() !== '' && (
                      <div className="flex rounded-md border border-border p-0.5">
                        {(['Write', 'Preview'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setPreviewExample(mode === 'Preview')}
                            className={cn(
                              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                              (mode === 'Preview') === previewExample
                                ? 'bg-muted text-foreground'
                                : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {previewExample && dialog.exampleOutput.trim() !== '' ? (
                    looksLikeHtml(unwrapHtmlFence(dialog.exampleOutput)) ? (
                      <HtmlPreview html={unwrapHtmlFence(dialog.exampleOutput)} />
                    ) : (
                      <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm leading-relaxed text-muted-foreground">{dialog.exampleOutput}</p>
                    )
                  ) : (
                    <Textarea id="template-dialog-example-output" rows={5} value={dialog.exampleOutput} onChange={(e) => setDialog({ ...dialog, exampleOutput: e.target.value })} placeholder="Illustrative output shown on the detail page — paste HTML to show a formatted report" />
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">HTML is supported: it renders as the formatted report on the template&apos;s detail page.</p>
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
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && !deletingAsset && setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.name || 'item'}?`}
        description="This removes the item from your workspace. Agents already created from a template are not changed."
        confirmLabel="Remove"
        destructive
        busy={deletingAsset}
        onConfirm={() => deleteTarget && deleteAsset(deleteTarget.kind, deleteTarget.id)}
      />
    </>
  )
}
