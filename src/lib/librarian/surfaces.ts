import type { Permission } from '@/lib/authz/permissions'
import type { LibrarianResult } from '@/lib/librarian/relevance'

/**
 * The pages of the product, as things the Assistant can point at.
 *
 * "Where do I connect Gmail?" is the single most common question a help widget
 * gets, and the Assistant could not answer it with a link: its candidate list
 * held templates, flows, agents and runs — the things a workspace CREATES —
 * and nothing at all for the app's own surfaces. It fell back to describing a
 * page in prose ("open the Integrations section") and the reader still had to
 * go and find it.
 *
 * Listing them here puts a page in the same numbering space as everything else,
 * so a navigation answer is cited exactly like a template is, and the href the
 * user clicks is still one this file wrote rather than one the model typed.
 *
 * `permission` is what a user needs to actually LOAD the page. A surface the
 * caller cannot open is dropped before the model ever sees it — pointing a
 * member at /admin/costs would be a link straight to a permission error, and
 * telling them the page exists is its own small leak of how the operator tier
 * is arranged.
 */
export type AppSurface = {
  id: string
  title: string
  href: string
  /** What the page is FOR, in one clause — this is what the model reads. */
  purpose: string
  /** Held permission required to open it; undefined means every member can. */
  permission?: Permission
}

export const APP_SURFACES: AppSurface[] = [
  {
    id: 'home',
    title: 'Home',
    href: '/dashboard',
    purpose: 'the Assistant home — ask a question, or jump back into a recent flow',
  },
  {
    id: 'agents',
    title: 'Agents',
    href: '/agents',
    purpose: 'build, run and watch agents; every run and its transcript lives here',
    permission: 'agent.read',
  },
  {
    id: 'flows',
    title: 'Flows',
    href: '/flows',
    purpose: 'multi-step pipelines that chain agents, branch on results and fan out — open one to edit it on the canvas',
    permission: 'flow.read',
  },
  {
    id: 'repository',
    title: 'Repository',
    href: '/data-tables',
    purpose: 'uploaded files and connected content agents can retrieve, plus typed data tables for reference data, queues and cross-run state',
    permission: 'flow.read',
  },
  {
    id: 'library',
    title: 'Library',
    href: '/templates',
    purpose: 'the ready-made agent and flow templates that ship with the product — open one to deploy it',
  },
  {
    id: 'integrations',
    title: 'Integrations',
    href: '/integrations',
    purpose: 'connect an app account (Slack, Gmail, Salesforce, Jira, Granola…) or add your own MCP server — this is where a new connection is made',
  },
  {
    id: 'credentials',
    title: 'Credentials',
    href: '/credentials',
    purpose: 'the connections already made — reconnect an expired account, rotate a leaked secret, or test one that stopped working',
    permission: 'flow.read',
  },
  {
    id: 'approvals',
    title: 'Approvals',
    href: '/approvals',
    purpose: 'actions a flow or agent has paused on, waiting for someone to approve or reject them',
  },
  {
    id: 'usage',
    title: 'Usage',
    href: '/usage',
    purpose: 'runs and model spend for this workspace, and how much of the allowance is left',
  },
  {
    id: 'settings-account',
    title: 'Account settings',
    href: '/settings',
    purpose: 'your own name, password and multi-factor authentication',
  },
  {
    id: 'settings-workspace',
    title: 'Workspace settings',
    href: '/settings?tab=workspace',
    purpose: 'the workspace name and logo',
  },
  {
    id: 'settings-members',
    title: 'Members',
    href: '/settings?tab=members',
    purpose: 'invite people, change a role, or remove someone from the workspace',
    permission: 'members.manage',
  },
  {
    id: 'settings-keys',
    title: 'Workspace keys',
    href: '/settings?tab=keys',
    purpose: 'the model API keys this workspace runs on',
  },
  {
    id: 'settings-security',
    title: 'Security settings',
    href: '/settings?tab=security',
    purpose: 'single sign-on, enforced MFA, allowed email domains and what may be sent to a model',
    permission: 'security.manage',
  },
  {
    id: 'settings-developer',
    title: 'Developer API',
    href: '/settings?tab=developer',
    purpose: 'API keys and webhooks for calling Backstory from your own code',
    permission: 'api.manage',
  },
  {
    id: 'settings-notifications',
    title: 'Notification settings',
    href: '/settings?tab=notifications',
    purpose: 'which events email you or post to Slack',
  },
  {
    id: 'settings-billing',
    title: 'Billing',
    href: '/settings?tab=billing',
    purpose: 'the workspace plan and invoices',
  },
  {
    id: 'settings-data',
    title: 'Data & privacy',
    href: '/settings?tab=data',
    purpose: 'export or delete workspace data, and the retention settings',
  },
  {
    id: 'admin-people',
    title: 'Admin · People',
    href: '/admin/users',
    purpose: 'the operator console for accounts across every workspace',
    permission: 'platform.administer',
  },
  {
    id: 'admin-costs',
    title: 'Admin · Model spend',
    href: '/admin/costs',
    purpose: 'model cost across every workspace, by user and by surface',
    permission: 'platform.administer',
  },
  {
    id: 'admin-adoption',
    title: 'Admin · Adoption',
    href: '/admin/adoption',
    purpose: 'who is actually using the platform, and how much',
    permission: 'platform.administer',
  },
  {
    id: 'admin-queue',
    title: 'Admin · Queue',
    href: '/admin/queue',
    purpose: 'the execution queue and its workers — where a stuck run is diagnosed',
    permission: 'platform.administer',
  },
  {
    id: 'admin-domains',
    title: 'Admin · Domains',
    href: '/admin/domains',
    purpose: 'verified email domains and which workspace they admit people to',
    permission: 'platform.administer',
  },
  {
    id: 'admin-catalogue',
    title: 'Reviews',
    href: '/admin/catalogue',
    purpose: 'templates submitted to the shared catalogue, waiting on a review decision',
    permission: 'catalogue.review',
  },
]

/**
 * The surfaces this caller can actually open, as citable candidates.
 *
 * `can` is passed in rather than an AuthContext so this stays pure and the
 * permission filter is directly testable.
 */
export function appSurfaces(can: (permission: Permission) => boolean): LibrarianResult[] {
  return APP_SURFACES.filter((surface) => !surface.permission || can(surface.permission)).map((surface) => ({
    type: 'page',
    id: surface.id,
    title: surface.title,
    subtitle: surface.purpose,
    href: surface.href,
  }))
}

/**
 * The page a pathname belongs to, so the answer can be written knowing where
 * the reader is standing ("the Runs panel here", rather than "wherever you are").
 *
 * Matched against the registry rather than echoed back: the path arrives from
 * the browser, and an unrecognised one simply yields no context instead of
 * putting client-supplied text into the prompt as if the product had said it.
 * Longest href first so /settings?tab=members beats bare /settings, and
 * /admin/costs beats a prefix of it.
 */
export function surfaceForPath(path: string | undefined): AppSurface | null {
  if (!path) return null
  const normalized = path.split('#')[0]
  const [pathname, query = ''] = normalized.split('?')
  const tab = new URLSearchParams(query).get('tab')
  const candidates = [...APP_SURFACES].sort((a, b) => b.href.length - a.href.length)
  for (const surface of candidates) {
    const [surfacePath, surfaceQuery = ''] = surface.href.split('?')
    if (surfaceQuery) {
      if (pathname === surfacePath && tab === new URLSearchParams(surfaceQuery).get('tab')) return surface
      continue
    }
    // A settings tab that has no surface of its own still belongs to Settings,
    // and a deeper route (/flows/<id>, /templates/<id>) belongs to its section.
    if (pathname === surfacePath || pathname.startsWith(`${surfacePath}/`)) return surface
  }
  return null
}
