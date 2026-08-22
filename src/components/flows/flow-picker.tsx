'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  BookOpen,
  Braces,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Clock,
  FileOutput,
  Filter,
  GitBranch,
  GitMerge,
  Globe,
  Play,
  RefreshCw,
  Repeat,
  Rows3,
  Search,
  SearchX,
  SlidersHorizontal,
  Sparkles,
  Split,
  Star,
  UserCheck,
  Variable,
  Webhook,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import type { StepType } from '@/lib/flows/mutate'
import {
  AI_CAPABILITY_LEAVES,
  BUILTIN_GROUPS,
  TRIGGER_LEAVES,
  searchCorpus,
  type PickerGroup,
  type PickerLeaf,
} from '@/lib/flows/builtin-catalog'
import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { groupToolConnections, toolConnectionBrand } from '@/lib/flows/tool-presentation'
import type { FlowInsertSeed } from './flow-canvas'
import type { ToolCatalog } from './step-drawer'

type Agent = { id: string; title: string }
type Connection = ToolCatalog[number]
type ConnectionTool = Connection['tools'][number]
type ProviderGroup = ReturnType<typeof groupToolConnections>[number]

const FAVORITES_KEY = 'flows.pickerFavorites.v1'

const ALL_LEAVES: PickerLeaf[] = [...AI_CAPABILITY_LEAVES, ...BUILTIN_GROUPS.flatMap((group) => group.children), ...TRIGGER_LEAVES]

const STEP_ICON: Partial<Record<StepType, LucideIcon>> = {
  ai: Sparkles,
  subflow: Workflow,
  knowledge: BookOpen,
  http: Globe,
  transform: SlidersHorizontal,
  condition: GitBranch,
  switch: Split,
  filter: Filter,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  agent: Bot,
  tool: Wrench,
  variable: Variable,
  data: Braces,
  humanReview: UserCheck,
  output: FileOutput,
  join: GitMerge,
}

const STEP_TONE: Partial<Record<StepType, string>> = {
  ai: 'bg-indigo-500 text-white',
  subflow: 'bg-teal-500 text-white',
  knowledge: 'bg-rose-500 text-white',
  http: 'bg-emerald-600 text-white',
  transform: 'bg-violet-500 text-white',
  condition: 'bg-amber-500 text-white',
  switch: 'bg-fuchsia-600 text-white',
  filter: 'bg-lime-600 text-white',
  loop: 'bg-sky-500 text-white',
  parallel: 'bg-cyan-600 text-white',
  stop: 'bg-red-500 text-white',
  agent: 'bg-slate-900 text-white',
  tool: 'bg-orange-500 text-white',
  variable: 'bg-purple-600 text-white',
  data: 'bg-violet-600 text-white',
  humanReview: 'bg-blue-600 text-white',
  output: 'bg-teal-600 text-white',
  join: 'bg-indigo-600 text-white',
}

const LEAF_ICON: Record<string, LucideIcon> = {
  'ai-run-agent': Bot,
  'ai-custom-agent': Bot,
  'ai-run-prompt': Sparkles,
}

const LEAF_TONE: Record<string, string> = {
  'ai-run-prompt': 'bg-indigo-600 text-white',
  'ai-custom-agent': 'bg-indigo-600 text-white',
}

const GROUP_ICON: Record<string, LucideIcon> = {
  http: Globe,
  control: GitBranch,
  'flow-basics': FileOutput,
  'data-operation': Braces,
  variable: Variable,
  'human-review': UserCheck,
}

const GROUP_TONE: Record<string, string> = {
  http: 'bg-emerald-600 text-white',
  control: 'bg-amber-500 text-white',
  'flow-basics': 'bg-teal-600 text-white',
  'data-operation': 'bg-violet-600 text-white',
  variable: 'bg-purple-600 text-white',
  'human-review': 'bg-blue-600 text-white',
}

const TRIGGER_ICON: Record<string, LucideIcon> = {
  manual: Play,
  schedule: Clock,
  webhook: Webhook,
  signal: Zap,
  poll: RefreshCw,
}

const TRIGGER_TONE: Record<string, string> = {
  manual: 'bg-slate-900 text-white',
  schedule: 'bg-blue-600 text-white',
  webhook: 'bg-violet-600 text-white',
  signal: 'bg-purple-600 text-white',
  poll: 'bg-cyan-600 text-white',
}

type Row = {
  id: string
  label: string
  description: string
  icon?: LucideIcon
  tone?: string
  logo?: { slug: string; name: string }
  favoriteId?: string
  chevron?: boolean
  onSelect: () => void
}

function loadFavorites(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveFavorites(ids: Set<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(ids)))
  } catch {
    // storage unavailable (private mode, quota) — favorites just won't persist
  }
}

function leafIcon(leaf: PickerLeaf): LucideIcon {
  return LEAF_ICON[leaf.id] ?? (leaf.stepType && STEP_ICON[leaf.stepType]) ?? (leaf.triggerType && TRIGGER_ICON[leaf.triggerType]) ?? Wrench
}

function leafTone(leaf: PickerLeaf): string {
  return LEAF_TONE[leaf.id] ?? (leaf.stepType && STEP_TONE[leaf.stepType]) ?? (leaf.triggerType && TRIGGER_TONE[leaf.triggerType]) ?? 'bg-slate-700 text-white'
}

function includesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query)
}

function connectionLogoSlug(connection: Connection): string {
  return toolConnectionBrand(connection).slug
}

// Connector key for tool-label humanization: prefixed planes name their
// connector in the ref (native:slack, nango:gmail, people_ai:backstory); MCP
// rows are opaque ids, so their display name is the key instead.
function connectionToolKey(connection: Connection): string {
  return toolConnectionBrand(connection).slug
}

const focusOnMount = (element: HTMLInputElement | null) => element?.focus()

export function FlowPicker({
  mode,
  agents,
  toolCatalog,
  onPick,
  onPickTrigger,
  onClose,
}: {
  mode: 'action' | 'trigger'
  agents: Agent[]
  toolCatalog: ToolCatalog
  onPick: (type: StepType, seed?: FlowInsertSeed) => void
  onPickTrigger?: (triggerType: 'manual' | 'schedule' | 'webhook' | 'signal' | 'poll' | 'activity' | 'slack') => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [drill, setDrill] = useState<{ kind: 'group'; group: PickerGroup } | { kind: 'connector'; provider: ProviderGroup } | null>(null)
  const [connectorFilter, setConnectorFilter] = useState<'all' | 'builtin' | 'connected'>('all')
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites())

  const normalizedQuery = query.trim().toLowerCase()
  const searching = normalizedQuery.length > 0

  // A live search always searches everything from the top; drilling back in
  // once the box is cleared would be confusing, so typing pops the picker out
  // of whatever group/connector it was drilled into.
  useEffect(() => {
    if (searching) setDrill(null)
  }, [searching])

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveFavorites(next)
      return next
    })
  }

  const pickLeaf = (leaf: PickerLeaf) => {
    if (leaf.triggerType) onPickTrigger?.(leaf.triggerType)
    else if (leaf.stepType) onPick(leaf.stepType, leaf.seed)
    onClose()
  }

  const leafRow = (leaf: PickerLeaf): Row => ({
    id: leaf.id,
    label: leaf.label,
    description: leaf.description,
    icon: leafIcon(leaf),
    tone: leafTone(leaf),
    favoriteId: leaf.id,
    onSelect: () => pickLeaf(leaf),
  })

  const agentRow = (agent: Agent): Row => ({
    id: `agent:${agent.id}`,
    label: agent.title,
    description: 'Run this agent and pass its response to the next step.',
    icon: Bot,
    tone: 'bg-slate-900 text-white',
    favoriteId: `agent:${agent.id}`,
    onSelect: () => {
      onPick('agent', { agentId: agent.id })
      onClose()
    },
  })

  const connectionToolRow = (connection: Connection, tool: ConnectionTool): Row => {
    const favoriteId = `tool:${encodeURIComponent(connection.id)}:${encodeURIComponent(tool.name)}`
    return {
      id: favoriteId,
      // Humanized DISPLAY label only — the raw tool.name stays the stored
      // toolName on the inserted node (see onSelect below).
      label: humanizeToolName(tool.name, connectionToolKey(connection)),
      description: tool.description || 'Run this connected action.',
      logo: { slug: connectionLogoSlug(connection), name: connection.name },
      favoriteId,
      onSelect: () => {
        onPick('tool', { connectionId: connection.id, toolName: tool.name, label: tool.name })
        onClose()
      },
    }
  }

  const groupRow = (group: PickerGroup): Row => ({
    id: `group:${group.id}`,
    label: group.label,
    description: group.description,
    icon: GROUP_ICON[group.id] ?? Wrench,
    tone: GROUP_TONE[group.id] ?? 'bg-slate-700 text-white',
    chevron: true,
    onSelect: () => setDrill({ kind: 'group', group }),
  })

  const connectionRow = (provider: ProviderGroup): Row => {
    const actionCount = provider.connections.reduce((count, connection) => count + connection.tools.length, 0)
    const firstError = provider.connections.find((connection) => connection.toolsError)?.toolsError
    return {
      id: `connection:${provider.brand.key}`,
      label: provider.brand.label,
      description: actionCount
        ? `${actionCount} available action${actionCount === 1 ? '' : 's'}`
        : firstError
          ? firstError
        : 'No actions available yet.',
      logo: { slug: provider.brand.slug, name: provider.brand.label },
      chevron: true,
      onSelect: () => setDrill({ kind: 'connector', provider }),
    }
  }

  const resolveFavorite = (id: string): Row | undefined => {
    if (id.startsWith('agent:')) {
      if (mode !== 'action') return undefined
      const agent = agents.find((a) => a.id === id.slice('agent:'.length))
      return agent ? agentRow(agent) : undefined
    }
    if (id.startsWith('tool:')) {
      if (mode !== 'action') return undefined
      const rest = id.slice('tool:'.length)
      const sep = rest.indexOf(':')
      if (sep === -1) return undefined
      let connectionId = decodeURIComponent(rest.slice(0, sep))
      let toolName = decodeURIComponent(rest.slice(sep + 1))
      // Backward compatibility for v1 favorite ids, whose raw connection id
      // could itself contain ":" (for example nango:slack).
      if (!toolCatalog.some((connection) => connection.id === connectionId)) {
        const legacy = toolCatalog.find((connection) => rest.startsWith(`${connection.id}:`))
        if (legacy) {
          connectionId = legacy.id
          toolName = rest.slice(legacy.id.length + 1)
        }
      }
      const connection = toolCatalog.find((c) => c.id === connectionId)
      const tool = connection?.tools.find((t) => t.name === toolName)
      return connection && tool ? connectionToolRow(connection, tool) : undefined
    }
    const leaf = ALL_LEAVES.find((l) => l.id === id)
    if (!leaf) return undefined
    if (mode === 'action' && leaf.mode === 'trigger') return undefined
    if (mode === 'trigger' && leaf.mode === 'action') return undefined
    return leafRow(leaf)
  }

  const favoriteRows = useMemo(() => {
    return Array.from(favorites)
      .map(resolveFavorite)
      .filter((row): row is Row => Boolean(row))
      .filter((row) => !searching || includesQuery(`${row.label} ${row.description}`, normalizedQuery))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favorites, agents, toolCatalog, mode, searching, normalizedQuery])

  const baseTitle = mode === 'trigger' ? 'Add a trigger' : 'Node Panel'
  const drillLabel = drill?.kind === 'group' ? drill.group.label : drill?.kind === 'connector' ? drill.provider.brand.label : null
  const drillSubtitle =
    drill?.kind === 'group'
      ? drill.group.description
      : drill?.kind === 'connector'
        ? drill.provider.connections.every((connection) => connection.tools.length === 0)
          ? drill.provider.connections.find((connection) => connection.toolsError)?.toolsError
          : `Choose an action from ${drill.provider.brand.label}.`
        : undefined

  let body: React.ReactNode

  if (drill && !searching) {
    const rows =
      drill.kind === 'group'
        ? drill.group.children.map(leafRow)
        : drill.provider.connections.flatMap((connection) =>
            connection.tools.map((tool) => connectionToolRow(connection, tool)),
          )
    body = (
      <>
        {rows.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((row) => (
              <RowCard key={row.id} row={row} favorited={row.favoriteId ? favorites.has(row.favoriteId) : false} onToggleFavorite={toggleFavorite} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Search}
            title="Nothing here yet"
            description="Connect this integration's tools and they appear here."
            className="py-8"
          />
        )}
      </>
    )
  } else if (mode === 'trigger') {
    const triggerRows = TRIGGER_LEAVES.filter((leaf) => !searching || includesQuery(searchCorpus(leaf), normalizedQuery)).map(leafRow)
    body = (
      <>
        <RowSection title="Favorites" rows={favoriteRows} favorites={favorites} onToggleFavorite={toggleFavorite} />
        <RowSection title="Triggers" rows={triggerRows} favorites={favorites} onToggleFavorite={toggleFavorite} />
        {favoriteRows.length + triggerRows.length === 0 && (
          <EmptyState icon={SearchX} title="No matching triggers" description="Try a different search term." className="py-8" />
        )}
      </>
    )
  } else {
    const aiLeafRows = AI_CAPABILITY_LEAVES.filter((leaf) => !searching || includesQuery(searchCorpus(leaf), normalizedQuery)).map(leafRow)
    const aiAgentRows = agents.filter((agent) => !searching || includesQuery(agent.title, normalizedQuery)).map(agentRow)
    const aiRows = [...aiLeafRows, ...aiAgentRows]

    const builtInRows = searching
      ? BUILTIN_GROUPS.flatMap((group) => group.children).filter((leaf) => includesQuery(searchCorpus(leaf), normalizedQuery)).map(leafRow)
      : BUILTIN_GROUPS.map(groupRow)

    const showBuiltInConnectors = connectorFilter === 'all' || connectorFilter === 'builtin'
    const showRealConnectors = connectorFilter === 'all' || connectorFilter === 'connected'

    const connectorBuiltInRows = showBuiltInConnectors ? builtInRows : []
    const connectorRealRows = showRealConnectors
      ? searching
        ? toolCatalog.flatMap((connection) =>
            connection.tools
              // Search what the user READS (the humanized label) as well as the
              // raw tool name and description.
              .filter((tool) =>
                includesQuery(
                  `${humanizeToolName(tool.name, connectionToolKey(connection))} ${tool.name} ${tool.description}`,
                  normalizedQuery,
                ),
              )
              .map((tool) => connectionToolRow(connection, tool)),
          )
        : groupToolConnections(toolCatalog).map(connectionRow)
      : []
    const connectorRows = [...connectorBuiltInRows, ...connectorRealRows]

    const totalRows = favoriteRows.length + aiRows.length + builtInRows.length + connectorRows.length

    body = (
      <>
        <RowSection title="Favorites" rows={favoriteRows} favorites={favorites} onToggleFavorite={toggleFavorite} />
        <RowSection title="AI capabilities" rows={aiRows} favorites={favorites} onToggleFavorite={toggleFavorite} />
        <RowSection title="Built-in tools" rows={builtInRows} favorites={favorites} onToggleFavorite={toggleFavorite} />
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">By connector</h4>
          <div className="mb-2 flex items-center gap-2">
            {(['all', 'builtin', 'connected'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setConnectorFilter(key)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                  connectorFilter === key
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800',
                )}
              >
                {key === 'all' ? 'All' : key === 'builtin' ? 'Built-in' : 'Connected'}
              </button>
            ))}
          </div>
          {connectorRows.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {connectorRows.map((row) => (
                <RowCard key={row.id} row={row} favorited={row.favoriteId ? favorites.has(row.favoriteId) : false} onToggleFavorite={toggleFavorite} />
              ))}
            </div>
          )}
          {showRealConnectors && toolCatalog.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
              Connected tools will show here after this workspace has integrations available.
            </div>
          )}
        </section>
        {totalRows === 0 && (
          <EmptyState icon={SearchX} title="No matching actions" description="Try a different search term." className="py-8" />
        )}
      </>
    )
  }

  return (
    <div className="flex max-h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-200 p-4">
        {drillLabel ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDrill(null)}
              aria-label="Back"
              className="rounded-full p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-lg font-semibold text-slate-950">
              {baseTitle} <span className="text-slate-400">›</span> {drillLabel}
            </p>
          </div>
        ) : (
          <>
            <p className="text-lg font-semibold text-slate-950">{baseTitle}</p>
            <p className="mt-1 text-sm text-slate-500">
              {mode === 'trigger' ? 'Choose how this flow starts.' : 'Choose what should happen next in this flow.'}
            </p>
          </>
        )}
        {drillSubtitle && <p className="mt-1 text-sm text-slate-500">{drillSubtitle}</p>}
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
          <Search className="h-4 w-4 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-950 outline-none placeholder:text-fg-muted"
            placeholder={mode === 'trigger' ? 'Search triggers' : 'Search agents, actions, or connectors'}
            data-testid="picker-search"
            ref={focusOnMount}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">{body}</div>
    </div>
  )
}

function RowSection({
  title,
  rows,
  favorites,
  onToggleFavorite,
}: {
  title: string
  rows: Row[]
  favorites: Set<string>
  onToggleFavorite: (id: string) => void
}) {
  if (!rows.length) return null
  return (
    <section>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{title}</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <RowCard key={row.id} row={row} favorited={row.favoriteId ? favorites.has(row.favoriteId) : false} onToggleFavorite={onToggleFavorite} />
        ))}
      </div>
    </section>
  )
}

function RowCard({
  row,
  favorited,
  onToggleFavorite,
}: {
  row: Row
  favorited: boolean
  onToggleFavorite: (id: string) => void
}) {
  const Icon = row.icon
  return (
    <div className="group relative flex min-h-[84px] min-w-0 items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50">
      <button type="button" onClick={row.onSelect} className="flex min-w-0 flex-1 items-start gap-3 text-left">
        {row.logo ? (
          <IntegrationLogo slug={row.logo.slug} name={row.logo.name} className="h-10 w-10 rounded-lg bg-white p-1 shadow-sm" />
        ) : Icon ? (
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', row.tone)}>
            <Icon className="h-5 w-5" />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 pr-5">
          <span className="block truncate text-sm font-semibold text-slate-950">{row.label}</span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-slate-500">{row.description}</span>
        </span>
      </button>
      {row.chevron && <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />}
      {row.favoriteId && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggleFavorite(row.favoriteId!)
          }}
          aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
          className="absolute right-2 top-2 text-slate-300 transition-colors hover:text-amber-500"
        >
          <Star className={cn('h-4 w-4', favorited && 'fill-amber-400 text-amber-500')} />
        </button>
      )}
    </div>
  )
}
