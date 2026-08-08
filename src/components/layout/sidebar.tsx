'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  ImagePlus,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Workflow,
} from 'lucide-react'
import { HomeIcon } from '@radix-ui/react-icons'
import { toast } from 'sonner'
import { CommandPalette } from '@/components/search/command-palette'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/use-auth'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { getSnapshot } from '@/lib/client/snapshot'
import { resizeImageToDataUrl } from '@/lib/client/image'
import { cn } from '@/lib/utils'
import type { Agent as AgentType } from '@/lib/types'

type Agent = Pick<AgentType, 'id' | 'title' | 'description' | 'instructions' | 'icon' | 'folder' | 'visibility'>

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }

/** Default workspace avatar — the Backstory mark, until an org uploads its own. */
const DEFAULT_ORG_LOGO = '/backstory-symbol-black.png'

/**
 * Downscale an uploaded image to a small square PNG data URL so the logo can
 * be stored inline (no object storage) and still render crisply at 32px.
 */
type Usage = { executions: number; inputTokens: number; outputTokens: number; exempt?: boolean }

// Module-level snapshot of the sidebar's fetched data, persisted across the
// component's remounts. Each top-level page renders its own <DashboardLayout>,
// so App Router remounts the Sidebar on every nav; without this it would reset
// to empty state and flash the default logo + no agents until the refetch
// resolves. Seeding state from this snapshot makes a remounted sidebar paint the
// real org logo + agents instantly, then revalidate in the background.
type SidebarSnapshot = { organizations: Organization[]; activeOrgId: string | null; agents: Agent[]; usage: Usage | null }
let sidebarCache: SidebarSnapshot | null = null

const CREDIT_TOKENS = 1_000_000
const SIDEBAR_COLLAPSED_KEY = 'backstory:sidebar-collapsed'
export const AGENTS_CHANGED_EVENT = 'backstory:agents-changed'

export function notifyAgentsChanged() {
  window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT))
}

const navigation = [
  { name: 'Home', href: '/dashboard', icon: HomeIcon },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Flows', href: '/flows', icon: Workflow },
  { name: 'Integrations', href: '/integrations', icon: Plug },
  { name: 'Credentials', href: '/credentials', icon: KeyRound },
]

// Super admins only. Customer workspaces never resolve catalogue.review (the
// org-kind double-gate in resolvePermissions), so the entry is absent there
// rather than shown-and-refused — one check covers both edition and role.
const reviewsNavItem = { name: 'Reviews', href: '/admin/catalogue', icon: ShieldCheck }

function planLabel(plan: string) {
  const lower = plan.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, signOut, can } = useAuth()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [orgMenuOpen, setOrgMenuOpen] = useState(false)
  const orgMenuRef = useRef<HTMLDivElement>(null)
  const orgButtonRef = useRef<HTMLButtonElement>(null)
  const [organizations, setOrganizations] = useState<Organization[]>(() => sidebarCache?.organizations ?? [])
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => sidebarCache?.activeOrgId ?? null)
  const [agents, setAgents] = useState<Agent[]>(() => sidebarCache?.agents ?? [])
  const [usage, setUsage] = useState<Usage | null>(() => sidebarCache?.usage ?? null)
  const [folderCollapsed, setFolderCollapsed] = useState<Record<string, boolean>>({})
  const [desktopCollapsed, setDesktopCollapsed] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    // One shared snapshot (deduped across the dashboard + bell within an ~8s
    // window) instead of three separate authenticated requests per poll.
    const snapshot = await getSnapshot(force ? 0 : undefined)
    const next: SidebarSnapshot = {
      organizations: snapshot.organizations || [],
      activeOrgId: snapshot.activeOrganizationId || null,
      agents: snapshot.agents || [],
      usage: snapshot.usage || null,
    }
    sidebarCache = next
    setAgents(next.agents)
    setUsage(next.usage)
    setOrganizations(next.organizations)
    setActiveOrgId(next.activeOrgId)
  }, [])

  useEffect(() => {
    load().catch(() => undefined)
    // Poll only while the tab is visible; refresh on return to the tab.
    const interval = window.setInterval(() => {
      if (!document.hidden) load().catch(() => undefined)
    }, 30000)
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  // No backdrop element: this sidebar's backdrop-blur + translate make it the
  // containing block for fixed children, so one rendered here covered only the
  // rail — leaving the menu unclosable from the content area while eating the
  // nav clicks underneath it.
  useDismissOnOutsidePointer(orgMenuOpen, () => setOrgMenuOpen(false), [orgMenuRef, orgButtonRef])

  useEffect(() => {
    try {
      setDesktopCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true')
    } catch {
      // Private browsing can disable storage; the expanded default still works.
    }
  }, [])

  const toggleDesktopSidebar = () => {
    setDesktopCollapsed((current) => {
      const next = !current
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
      } catch {
        // Keep the preference for this session when storage is unavailable.
      }
      return next
    })
  }

  const activeOrg = organizations.find((org) => org.id === activeOrgId) || organizations[0] || null

  const saveOrgLogo = async (logoUrl: string | null) => {
    setUploadingLogo(true)
    try {
      const response = await fetch('/api/organizations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logoUrl }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not update the workspace logo.')
        return
      }
      setOrganizations((previous) => {
        const updated = previous.map((org) =>
          org.id === data.organization?.id ? { ...org, logoUrl: data.organization.logoUrl } : org,
        )
        // Keep the cross-navigation snapshot in sync so the new logo doesn't
        // briefly revert on the next navigation before load() revalidates.
        if (sidebarCache) sidebarCache = { ...sidebarCache, organizations: updated }
        return updated
      })
      toast.success(logoUrl ? 'Workspace logo updated.' : 'Workspace logo removed.')
    } finally {
      setUploadingLogo(false)
    }
  }

  const uploadOrgLogo = async (file: File) => {
    try {
      const logoUrl = await resizeImageToDataUrl(file)
      await saveOrgLogo(logoUrl)
    } catch {
      toast.error('Could not read that image — try a PNG or JPEG.')
    }
  }

  const sections = useMemo(() => {
    const shared = agents.filter((agent) => agent.visibility !== 'private')
    const folders = new Map<string, Agent[]>()
    for (const agent of shared) {
      const key = agent.folder?.trim() || 'General'
      const bucket = folders.get(key)
      if (bucket) bucket.push(agent)
      else folders.set(key, [agent])
    }
    return {
      workspace: [...folders.entries()].sort(([a], [b]) => a.localeCompare(b)),
      private: agents.filter((agent) => agent.visibility === 'private'),
    }
  }, [agents])

  const creditPct = usage ? Math.min(100, Math.round(((usage.inputTokens + usage.outputTokens) / CREDIT_TOKENS) * 100)) : 0

  const moveAgent = async (agentId: string, target: { folder: string | null; visibility: 'shared' | 'private' }) => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    if (!agent) return
    if ((agent.folder || null) === target.folder && agent.visibility === target.visibility) return
    await fetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId, folder: target.folder, visibility: target.visibility }),
    })
    notifyAgentsChanged()
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
        notifyAgentsChanged()
        router.push('/dashboard')
      } else {
        toast.error(data.error || 'Run failed')
      }
    } finally {
      setRunningId(null)
    }
  }

  const deleteAgent = async (agent: Agent) => {
    await fetch('/api/agents', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agent.id }),
    })
    notifyAgentsChanged()
  }

  const dropProps = (key: string, target: { folder: string | null; visibility: 'shared' | 'private' }) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(key)
    },
    onDragLeave: () => setDragOver((current) => (current === key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(null)
      const agentId = event.dataTransfer.getData('text/agent-id')
      if (agentId) moveAgent(agentId, target).catch(() => undefined)
    },
  })

  const renderAgent = (agent: Agent) => (
    <div
      key={agent.id}
      draggable
      onDragStart={(event) => event.dataTransfer.setData('text/agent-id', agent.id)}
      className="group flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-fast hover:bg-graphite-100 active:cursor-grabbing"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-graphite-100 text-[11px] font-semibold uppercase leading-none text-graphite-700">
        {agent.icon || agent.title.trim().charAt(0) || 'A'}
      </span>
      <button
        className="flex-1 truncate rounded text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={agent.description || agent.title}
        onClick={() => router.push(`/agents?agent=${agent.id}`)}
      >
        {agent.title}
      </button>
      {/* group-focus-within keeps Run/Delete reachable when tabbing, not just on hover. */}
      <div className="hidden gap-0.5 group-focus-within:flex group-hover:flex">
        <Button size="icon" variant="ghost" className="h-6 w-6" disabled={runningId === agent.id} onClick={() => runAgent(agent)} aria-label="Run agent">
          {runningId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-red-600" onClick={() => deleteAgent(agent)} aria-label="Delete agent">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={250}>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-graphite-900/40 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="fixed left-4 top-4 z-50 lg:hidden">
        <Button variant="outline" size="icon" onClick={() => setMobileOpen(true)} className="bg-white shadow-2" aria-label="Open navigation">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Button>
      </div>

      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-graphite-200/80 bg-white/95 shadow-2 backdrop-blur-xl transition-all duration-200 lg:relative lg:translate-x-0 lg:shadow-none',
          desktopCollapsed && 'lg:w-16',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        {/* Org switcher */}
        <div className={cn('relative border-b p-3', desktopCollapsed && 'lg:px-2')}>
          <div className={cn('flex items-center gap-1', desktopCollapsed && 'lg:flex-col')}>
            <button
              ref={orgButtonRef}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-fast hover:bg-graphite-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                desktopCollapsed && 'lg:w-full lg:flex-none lg:justify-center lg:px-0',
              )}
              onClick={() => setOrgMenuOpen((open) => !open)}
              aria-label={`Workspace: ${activeOrg?.name || 'Workspace'}`}
              title={desktopCollapsed ? activeOrg?.name || 'Workspace' : undefined}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={activeOrg?.logoUrl || DEFAULT_ORG_LOGO}
                alt=""
                className="h-8 w-8 rounded-lg object-cover"
              />
              <span className={cn('flex-1 truncate text-left text-sm font-semibold', desktopCollapsed && 'lg:hidden')}>
                {activeOrg?.name || 'Workspace'}
              </span>
              <ChevronsUpDown className={cn('h-4 w-4 text-graphite-400', desktopCollapsed && 'lg:hidden')} />
            </button>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={toggleDesktopSidebar}
                  aria-label={desktopCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                  aria-expanded={!desktopCollapsed}
                  className="hidden h-8 w-8 shrink-0 rounded-lg text-graphite-500 hover:bg-graphite-100 hover:text-graphite-900 lg:inline-flex"
                >
                  {desktopCollapsed
                    ? <PanelLeftOpen className="h-4 w-4" />
                    : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {desktopCollapsed ? 'Expand navigation' : 'Collapse navigation'}
              </TooltipContent>
            </Tooltip>
          </div>
          {orgMenuOpen && (
            <div
              ref={orgMenuRef}
              className={cn(
                'absolute left-3 right-3 z-20 mt-1 origin-top animate-scale-in rounded-lg border bg-white p-1 shadow-popover',
                desktopCollapsed && 'lg:left-full lg:right-auto lg:top-0 lg:ml-2 lg:mt-0 lg:w-64',
              )}
            >
                {organizations.map((org) => (
                  <button
                    key={org.id}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-graphite-100"
                    onClick={() => setOrgMenuOpen(false)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={org.logoUrl || DEFAULT_ORG_LOGO} alt="" className="h-5 w-5 rounded object-cover" />
                    <span className="flex-1 truncate text-left">{org.name}</span>
                    <span className="text-xs text-graphite-400">{planLabel(org.plan)}</span>
                    {org.id === activeOrg?.id && <Check className="h-4 w-4 text-horizon-600" />}
                  </button>
                ))}
                <div className="my-1 border-t" />
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-graphite-700 hover:bg-graphite-100 disabled:opacity-50"
                  disabled={uploadingLogo}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {uploadingLogo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                  {activeOrg?.logoUrl ? 'Change workspace logo' : 'Upload workspace logo'}
                </button>
                {activeOrg?.logoUrl && (
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-graphite-700 hover:bg-graphite-100 disabled:opacity-50"
                    disabled={uploadingLogo}
                    onClick={() => saveOrgLogo(null)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove logo
                  </button>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file) uploadOrgLogo(file)
                  }}
                />
                <div className="my-1 border-t" />
                <div className="truncate px-2 py-1 text-xs text-graphite-400">{user?.emailAddress}</div>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-graphite-700 hover:bg-graphite-100"
                  onClick={signOut}
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
            </div>
          )}

          <div className={cn('mt-2 flex items-center gap-2', desktopCollapsed && 'lg:flex-col')}>
            <button
              className={cn(
                'flex flex-1 items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-sm text-graphite-400 transition-colors duration-fast hover:border-graphite-300 hover:text-graphite-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                desktopCollapsed && 'lg:h-9 lg:w-9 lg:flex-none lg:justify-center lg:px-0',
              )}
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              title={desktopCollapsed ? 'Search (⌘K)' : undefined}
            >
              <Search className="h-3.5 w-3.5" />
              <span className={cn('flex-1 text-left', desktopCollapsed && 'lg:hidden')}>Search</span>
              <kbd className={cn('rounded border bg-graphite-50 px-1.5 py-0.5 text-[10px]', desktopCollapsed && 'lg:hidden')}>⌘K</kbd>
            </button>
            <NotificationBell />
          </div>
        </div>

        {/* Nav + agent tree */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <nav className="mb-2 space-y-0.5">
            {(can('catalogue.review') ? [...navigation, reviewsNavItem] : navigation).map((item) => {
              const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  title={desktopCollapsed ? item.name : undefined}
                  aria-label={desktopCollapsed ? item.name : undefined}
                  className={cn(
                    'group relative flex items-center gap-2.5 overflow-hidden rounded-lg px-2 py-2 text-sm font-medium transition-colors duration-fast',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    desktopCollapsed && 'lg:justify-center lg:px-0 lg:py-2',
                    // The active item needs its own surface: rail + text color alone
                    // lose to a hovered sibling's bg-graphite-100.
                    isActive ? 'bg-horizon-50/80 text-horizon-700' : 'text-graphite-700 hover:bg-graphite-100 hover:text-graphite-900',
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="sidebar-active-nav"
                      className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-horizon-500"
                      transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                      aria-hidden="true"
                    />
                  )}
                  <item.icon className={cn('relative z-10 h-4 w-4 transition-transform duration-base group-hover:scale-110', desktopCollapsed && 'lg:h-5 lg:w-5', isActive ? 'text-horizon-600' : 'text-graphite-400')} />
                  <span className={cn('relative z-10', desktopCollapsed && 'lg:hidden')}>{item.name}</span>
                </Link>
              )
            })}
          </nav>

          <div className={cn(desktopCollapsed && 'lg:hidden')}>
            <div
              className={cn(
                'flex items-center justify-between rounded-lg px-2 pb-1 pt-3',
                dragOver === 'workspace' && 'bg-horizon-50',
              )}
              {...dropProps('workspace', { folder: null, visibility: 'shared' })}
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-graphite-400">Workspace</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => router.push('/agents?agent=new')}
                aria-label="New agent"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
            {sections.workspace.map(([folder, folderAgents]) => {
              const key = `ws:${folder}`
              const isCollapsed = folderCollapsed[key]
              const isGeneral = folder === 'General'
              return (
                <div key={key} className="mb-0.5">
                  <button
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-graphite-700 hover:bg-graphite-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      dragOver === key && 'bg-horizon-50',
                    )}
                    onClick={() => setFolderCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                    {...dropProps(key, { folder: isGeneral ? null : folder, visibility: 'shared' })}
                  >
                    {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                    <Folder className="h-3.5 w-3.5 text-graphite-400" />
                    <span className="flex-1 truncate text-left">{folder}</span>
                    <span className="text-xs text-graphite-400">{folderAgents.length}</span>
                  </button>
                  {!isCollapsed && <div className="ml-3 border-l pl-1">{folderAgents.map(renderAgent)}</div>}
                </div>
              )
            })}

            <div
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-graphite-400',
                dragOver === 'private' && 'bg-horizon-50',
              )}
              {...dropProps('private', { folder: null, visibility: 'private' })}
            >
              <Lock className="h-3 w-3" /> Private
            </div>
            {sections.private.length > 0
              ? <div className="ml-3 border-l pl-1">{sections.private.map(renderAgent)}</div>
              : <p className="px-2 py-1 text-xs text-graphite-400">Drag agents here to make them private.</p>}
          </div>
        </div>

        {/* Footer: usage + user */}
        <div className={cn('border-t p-3', desktopCollapsed && 'lg:px-2')}>
          {usage && (
            <div className={cn('mb-2 px-1', desktopCollapsed && 'lg:hidden')}>
              <div className="mb-1 flex justify-between text-xs text-graphite-500">
                <span>Usage this month</span>
                <span>{usage.exempt ? 'Unlimited' : `${creditPct}% of credits`}</span>
              </div>
              {!usage.exempt && (
                <div className="h-1.5 overflow-hidden rounded-full bg-graphite-200">
                  <div className="h-full rounded-full bg-horizon-500 transition-[width] duration-slow ease-out-quart" style={{ width: `${creditPct}%` }} />
                </div>
              )}
            </div>
          )}
          <Link
            href="/settings"
            className={cn(
              'flex items-center gap-2 rounded-lg px-1 py-1 transition-colors duration-fast hover:bg-graphite-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              desktopCollapsed && 'lg:justify-center lg:px-0',
            )}
            title="Settings"
            aria-label={desktopCollapsed ? 'Settings' : undefined}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-graphite-200 text-xs font-semibold text-graphite-600">
              {(user?.firstName || 'U').charAt(0).toUpperCase()}
            </div>
            <div className={cn('min-w-0 flex-1', desktopCollapsed && 'lg:hidden')}>
              <div className="truncate text-sm font-medium">{user?.firstName || 'Account'}</div>
              <div className="truncate text-xs text-graphite-400">{user?.emailAddress}</div>
            </div>
            {activeOrg && (
              <span className={cn('rounded-full bg-graphite-200 px-2 py-0.5 text-xs text-graphite-600', desktopCollapsed && 'lg:hidden')}>
                {planLabel(activeOrg.plan)}
              </span>
            )}
          </Link>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </TooltipProvider>
  )
}
