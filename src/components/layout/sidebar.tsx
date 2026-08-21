'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import {
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  ImagePlus,
  Loader2,
  Lock,
  LogOut,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  ShieldUser,
  Trash2,
  Workflow,
} from 'lucide-react'
import { HomeIcon } from '@radix-ui/react-icons'
import { toast } from 'sonner'
import { CommandPalette } from '@/components/search/command-palette'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DemoChip, DemoModeMenuItem } from '@/components/layout/demo-chip'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/hooks/use-auth'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { resetSnapshotCache, getSnapshot } from '@/lib/client/snapshot'
import { resizeImageToDataUrl } from '@/lib/client/image'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { cn } from '@/lib/utils'
import type { Agent as AgentType } from '@/lib/types'

type Agent = Pick<AgentType, 'id' | 'title' | 'description' | 'instructions' | 'avatarSeed' | 'folder' | 'visibility'>

type Organization = { id: string; name: string; slug: string; plan: string; logoUrl?: string | null }
type WorkspaceFolder = { id: string; name: string }

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
type SidebarSnapshot = { organizations: Organization[]; activeOrgId: string | null; agents: Agent[]; workspaceFolders: WorkspaceFolder[]; usage: Usage | null }
let sidebarCache: SidebarSnapshot | null = null

const CREDIT_TOKENS = 1_000_000
const SIDEBAR_COLLAPSED_KEY = 'backstory:sidebar-collapsed'
export const AGENTS_CHANGED_EVENT = 'backstory:agents-changed'

export function notifyAgentsChanged() {
  // Evict the shared snapshot BEFORE waking the listeners. The event makes
  // subscribed surfaces (this sidebar, the agents page) reload with force —
  // but any consumer calling plain getSnapshot() inside the 8s freshness
  // window (the dashboard's poll, the bell) was still handed the PRE-edit
  // snapshot back, and the localStorage copy would instant-paint the pre-edit
  // state on the next reload. Clearing the cache fixes every consumer at
  // once, subscribed or not.
  resetSnapshotCache()
  window.dispatchEvent(new CustomEvent(AGENTS_CHANGED_EVENT))
}

// Credentials is deliberately absent: it's a Flows-scoped surface, reached
// from the Credentials button on /flows (and it links back there).
const navigation = [
  { name: 'Home', href: '/dashboard', icon: HomeIcon },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Flows', href: '/flows', icon: Workflow },
  { name: 'Library', href: '/templates', icon: BookOpen },
  { name: 'Integrations', href: '/integrations', icon: Plug },
]

// Super admins only. Customer workspaces never resolve catalogue.review (the
// org-kind double-gate in resolvePermissions), so the entry is absent there
// rather than shown-and-refused — one check covers both edition and role.
const reviewsNavItem = { name: 'Reviews', href: '/admin/catalogue', icon: ShieldCheck }

// A STRICTER gate than Reviews, and not an oversight: catalogue.review is also
// held by reviewers in partner workspaces, while this page carries every user's
// personal details, the account actions, and cross-workspace model spend.
// platform.administer is the operator tier alone. The route re-checks it — this
// only decides whether to draw a link.
//
// Named for the console rather than its first tab: the page holds People and
// Models, and calling it "Users" hid the second one behind a label that denied
// it existed. The href still lands on People.
const adminNavItem = { name: 'Admin', href: '/admin/users', icon: ShieldUser }

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
  const mobileSidebarRef = useRef<HTMLElement>(null)
  const mobileTriggerRef = useRef<HTMLButtonElement>(null)
  const [organizations, setOrganizations] = useState<Organization[]>(() => sidebarCache?.organizations ?? [])
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const [activeOrgId, setActiveOrgId] = useState<string | null>(() => sidebarCache?.activeOrgId ?? null)
  const [agents, setAgents] = useState<Agent[]>(() => sidebarCache?.agents ?? [])
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>(() => sidebarCache?.workspaceFolders ?? [])
  const [usage, setUsage] = useState<Usage | null>(() => sidebarCache?.usage ?? null)
  const [folderCollapsed, setFolderCollapsed] = useState<Record<string, boolean>>({})
  const [desktopCollapsed, setDesktopCollapsed] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null)
  const [deletingAgent, setDeletingAgent] = useState(false)
  const [folderDialog, setFolderDialog] = useState<{ mode: 'create' | 'rename'; id?: string; name: string } | null>(null)
  const [savingFolder, setSavingFolder] = useState(false)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<WorkspaceFolder | null>(null)
  const [deletingFolder, setDeletingFolder] = useState(false)

  const load = useCallback(async (force = false) => {
    // One shared snapshot (deduped across the dashboard + bell within an ~8s
    // window) instead of three separate authenticated requests per poll.
    const snapshot = await getSnapshot(force ? 0 : undefined)
    const next: SidebarSnapshot = {
      organizations: snapshot.organizations || [],
      activeOrgId: snapshot.activeOrganizationId || null,
      agents: snapshot.agents || [],
      workspaceFolders: snapshot.workspaceFolders || [],
      usage: snapshot.usage || null,
    }
    sidebarCache = next
    setAgents(next.agents)
    setWorkspaceFolders(next.workspaceFolders)
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

  useEffect(() => {
    const sidebar = mobileSidebarRef.current
    if (!sidebar) return
    const mobile = window.matchMedia('(max-width: 1023px)')
    const updateInert = () => { sidebar.inert = mobile.matches && !mobileOpen }
    updateInert()
    mobile.addEventListener('change', updateInert)
    return () => {
      sidebar.inert = false
      mobile.removeEventListener('change', updateInert)
    }
  }, [mobileOpen])

  useEffect(() => {
    if (!mobileOpen) return
    const sidebar = mobileSidebarRef.current
    const focusable = () => Array.from(sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileOpen(false)
        mobileTriggerRef.current?.focus()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    window.requestAnimationFrame(() => focusable()[0]?.focus())
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [mobileOpen])

  // No backdrop element: this sidebar's backdrop-blur + translate make it the
  // containing block for fixed children, so one rendered here covered only the
  // rail — leaving the menu unclosable from the content area while eating the
  // nav clicks underneath it.
  useDismissOnOutsidePointer(orgMenuOpen, () => setOrgMenuOpen(false), [orgMenuRef, orgButtonRef])

  useEffect(() => {
    if (!orgMenuOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOrgMenuOpen(false)
      orgButtonRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [orgMenuOpen])

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
    const explicitByName = new Map(workspaceFolders.map((folder) => [folder.name.toLocaleLowerCase(), folder]))
    folders.set('General', [])
    for (const folder of workspaceFolders) folders.set(folder.name, [])
    for (const agent of shared) {
      const requested = agent.folder?.trim() || 'General'
      const key = explicitByName.get(requested.toLocaleLowerCase())?.name ?? requested
      const bucket = folders.get(key)
      if (bucket) bucket.push(agent)
      else folders.set(key, [agent])
    }
    return {
      workspace: [...folders.entries()]
        .map(([name, folderAgents]) => ({ name, agents: folderAgents, folder: explicitByName.get(name.toLocaleLowerCase()) ?? null }))
        .sort((a, b) => a.name === 'General' ? -1 : b.name === 'General' ? 1 : a.name.localeCompare(b.name)),
      private: agents.filter((agent) => agent.visibility === 'private'),
    }
  }, [agents, workspaceFolders])

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

  const saveWorkspaceFolder = async () => {
    if (!folderDialog || savingFolder) return
    const name = folderDialog.name.trim().replace(/\s+/g, ' ')
    if (!name) {
      toast.error('Enter a folder name.')
      return
    }
    setSavingFolder(true)
    try {
      const response = await fetch('/api/workspace-folders', {
        method: folderDialog.mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(folderDialog.mode === 'create' ? { name } : { id: folderDialog.id, name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the public folder.')
      setFolderDialog(null)
      setFolderCollapsed((current) => ({ ...current, [`ws:${data.folder.name}`]: false }))
      toast.success(folderDialog.mode === 'create' ? `Created ${data.folder.name}` : `Renamed folder to ${data.folder.name}`)
      notifyAgentsChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the public folder.')
    } finally {
      setSavingFolder(false)
    }
  }

  const deleteWorkspaceFolder = async (folder: WorkspaceFolder) => {
    setDeletingFolder(true)
    try {
      const response = await fetch('/api/workspace-folders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: folder.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not delete the public folder.')
      setDeleteFolderTarget(null)
      toast.success(data.moved > 0 ? `Deleted ${folder.name}; ${data.moved} agent${data.moved === 1 ? '' : 's'} moved to General` : `Deleted ${folder.name}`)
      notifyAgentsChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the public folder.')
    } finally {
      setDeletingFolder(false)
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
        notifyAgentsChanged()
        router.push(`/agents?agent=${agent.id}`)
      } else {
        toast.error(data.error || 'Run failed')
      }
    } finally {
      setRunningId(null)
    }
  }

  const deleteAgent = async (agent: Agent) => {
    setDeletingAgent(true)
    try {
      const response = await fetch('/api/agents', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: agent.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not delete the agent.')
      setDeleteTarget(null)
      toast.success(`Deleted ${agent.title}`)
      notifyAgentsChanged()
      if (pathname === '/agents') router.push('/agents')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the agent.')
    } finally {
      setDeletingAgent(false)
    }
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
      <AgentAvatar seed={agent.avatarSeed || agent.id} className="h-6 w-5 shrink-0 rounded-md ring-1 ring-black/5" />
      <button
        className="flex-1 truncate rounded text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={agent.description || agent.title}
        onClick={() => router.push(`/agents?agent=${agent.id}`)}
      >
        {agent.title}
      </button>
      <div className="flex gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={runningId === agent.id} onClick={() => runAgent(agent)} aria-label={`Run ${agent.title}`}>
          {runningId === agent.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8 text-red-600" onClick={() => setDeleteTarget(agent)} aria-label={`Delete ${agent.title}`}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={250}>
      {mobileOpen && (
        <div role="presentation" className="fixed inset-0 z-40 bg-graphite-900/40 backdrop-blur-sm lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="fixed left-4 top-4 z-50 lg:hidden">
        <Button ref={mobileTriggerRef} variant="outline" size="icon" onClick={() => setMobileOpen(true)} className="bg-white shadow-2" aria-label="Open navigation" aria-expanded={mobileOpen}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </Button>
      </div>

      <aside
        ref={mobileSidebarRef}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? 'Workspace navigation' : undefined}
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
              aria-haspopup="true"
              aria-expanded={orgMenuOpen}
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
                    <span className="text-xs text-fg-muted">{planLabel(org.plan)}</span>
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
                <DemoModeMenuItem />
                <div className="my-1 border-t" />
                <div className="truncate px-2 py-1 text-xs text-fg-muted">{user?.emailAddress}</div>
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-graphite-700 hover:bg-graphite-100"
                  onClick={signOut}
                >
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
            </div>
          )}

          <DemoChip />
          <div className={cn('mt-2 flex items-center gap-2', desktopCollapsed && 'lg:flex-col')}>
            <button
              className={cn(
                'flex flex-1 items-center gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-sm text-fg-muted transition-colors duration-fast hover:border-graphite-300 hover:text-graphite-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                desktopCollapsed && 'lg:h-9 lg:w-9 lg:flex-none lg:justify-center lg:px-0',
              )}
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              title={desktopCollapsed ? 'Search (⌘K)' : undefined}
            >
              <Search className="h-3.5 w-3.5" />
              <span className={cn('flex-1 text-left', desktopCollapsed && 'lg:hidden')}>Search</span>
            </button>
            <NotificationBell />
          </div>
        </div>

        {/* Nav + agent tree */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <nav aria-label="Main navigation" className="mb-2 space-y-0.5">
            {[
              ...navigation,
              ...(can('catalogue.review') ? [reviewsNavItem] : []),
              ...(can('platform.administer') ? [adminNavItem] : []),
            ].map((item) => {
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
                  <item.icon className={cn('relative z-10 h-4 w-4 transition-transform duration-base group-hover:scale-110', desktopCollapsed && 'lg:h-5 lg:w-5', isActive ? 'text-horizon-600' : 'text-fg-muted')} />
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
              <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Workspace</span>
              {can('agent.write') && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-6 w-6" aria-label="Add to workspace">
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={() => setFolderDialog({ mode: 'create', name: '' })}>
                      <FolderPlus /> Public folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => router.push('/agents?agent=new')}>
                      <Bot /> New agent
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {sections.workspace.map(({ name: folder, agents: folderAgents, folder: folderRecord }) => {
              const key = `ws:${folder}`
              const isCollapsed = folderCollapsed[key]
              const isGeneral = folder === 'General'
              return (
                <div key={key} className="mb-0.5">
                  <div className="group flex items-center gap-0.5">
                    <button
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-graphite-700 hover:bg-graphite-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        dragOver === key && 'bg-horizon-50',
                      )}
                      onClick={() => setFolderCollapsed((current) => ({ ...current, [key]: !current[key] }))}
                      {...dropProps(key, { folder: isGeneral ? null : folder, visibility: 'shared' })}
                    >
                      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      <Folder className="h-3.5 w-3.5 text-graphite-400" />
                      <span className="flex-1 truncate text-left">{folder}</span>
                      <span className="text-xs text-fg-muted">{folderAgents.length}</span>
                    </button>
                    {folderRecord && can('agent.write') && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-fg-muted" aria-label={`Manage ${folder}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setFolderDialog({ mode: 'rename', id: folderRecord.id, name: folderRecord.name })}>
                            <Pencil /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-red-600 focus:text-red-700" onSelect={() => setDeleteFolderTarget(folderRecord)}>
                            <Trash2 /> Delete folder
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {!isCollapsed && (
                    folderAgents.length > 0
                      ? <div className="ml-3 border-l pl-1">{folderAgents.map(renderAgent)}</div>
                      : !isGeneral && <p className="ml-5 px-2 py-1 text-xs text-fg-muted">Empty — drag an agent here.</p>
                  )}
                </div>
              )
            })}

            <div
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-muted',
                dragOver === 'private' && 'bg-horizon-50',
              )}
              {...dropProps('private', { folder: null, visibility: 'private' })}
            >
              <Lock className="h-3 w-3" /> Private
            </div>
            {sections.private.length > 0
              ? <div className="ml-3 border-l pl-1">{sections.private.map(renderAgent)}</div>
              : <p className="px-2 py-1 text-xs text-fg-muted">Drag agents here to make them private.</p>}
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
              <div className="truncate text-xs text-fg-muted">{user?.emailAddress}</div>
            </div>
            {activeOrg && (
              <span className={cn('rounded-full bg-graphite-200 px-2 py-0.5 text-xs text-graphite-600', desktopCollapsed && 'lg:hidden')}>
                {planLabel(activeOrg.plan)}
              </span>
            )}
          </Link>
        </div>
      </aside>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Dialog open={folderDialog !== null} onOpenChange={(open) => { if (!open && !savingFolder) setFolderDialog(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{folderDialog?.mode === 'rename' ? 'Rename public folder' : 'Create a public folder'}</DialogTitle>
            <DialogDescription>
              Everyone in this workspace can see this folder. Drag shared agents into it from the sidebar.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5 text-sm" htmlFor="workspace-folder-name">
            <span className="font-medium">Folder name</span>
            <Input
              id="workspace-folder-name"
              autoFocus
              maxLength={60}
              value={folderDialog?.name ?? ''}
              onChange={(event) => setFolderDialog((current) => current ? { ...current, name: event.target.value } : current)}
              onKeyDown={(event) => { if (event.key === 'Enter') void saveWorkspaceFolder() }}
              placeholder="For example, Sales operations"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialog(null)} disabled={savingFolder}>Cancel</Button>
            <Button onClick={() => void saveWorkspaceFolder()} loading={savingFolder}>
              {folderDialog?.mode === 'rename' ? 'Save name' : 'Create folder'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && !deletingAgent && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.title || 'agent'}?`}
        description="This permanently removes the agent and its configuration. Existing run history is not changed."
        confirmLabel="Delete agent"
        destructive
        busy={deletingAgent}
        onConfirm={() => deleteTarget && deleteAgent(deleteTarget)}
      />
      <ConfirmDialog
        open={deleteFolderTarget !== null}
        onOpenChange={(open) => !open && !deletingFolder && setDeleteFolderTarget(null)}
        title={`Delete ${deleteFolderTarget?.name || 'folder'}?`}
        description="The public folder will be removed. Agents inside it will stay shared and move to General."
        confirmLabel="Delete folder"
        destructive
        busy={deletingFolder}
        onConfirm={() => deleteFolderTarget && deleteWorkspaceFolder(deleteFolderTarget)}
      />
    </TooltipProvider>
  )
}
