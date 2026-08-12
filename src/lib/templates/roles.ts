/**
 * The role taxonomy the Templates library filters by.
 *
 * Nothing in the catalogue carries a role field. Templates have a category and
 * tags; skills carry an `audience` list written in job titles ("AEs", "RevOps",
 * "Solutions Engineers"). Rather than backfill a column onto forty-odd built-ins
 * and every community submission — and leave everything already stored
 * unfilterable — a role is DERIVED from the classification text an item already
 * has.
 *
 * Only classification fields feed the match (category, tags, audience), never
 * the description: a template whose prose happens to mention marketing is not a
 * marketing template, and matching prose made the filter mean nothing.
 *
 * An item can hold several roles — account planning is Sales and CSM work — and
 * one that matches nothing is reachable under "All roles" only, which is honest
 * about the fact that we are inferring rather than reading a field.
 */

/** Canonical roles, in the order the filter offers them. */
export const ROLES = ['IT', 'CSM', 'Sales', 'Marketing'] as const

export type Role = (typeof ROLES)[number]

/** The dropdown's "no role filter" choice. Not a role — a sentinel. */
export const ALL_ROLES = 'All'

/**
 * Job titles, categories, and tags that place an item with a role. Matched
 * whole-word, so "ae" does not fire on "aggregate" and "it" not on "with".
 */
const ROLE_KEYWORDS: Record<Role, string[]> = {
  IT: [
    'it', 'platform', 'platforms', 'engineer', 'engineers', 'engineering', 'architect', 'architects',
    'architecture', 'admin', 'admins', 'administration', 'integration', 'integrations', 'data',
    'security', 'qa', 'devops', 'implementation', 'technical', 'infrastructure', 'api', 'apis',
  ],
  CSM: [
    'csm', 'csms', 'cs', 'customer', 'customers', 'success', 'renewal', 'renewals', 'retention',
    'adoption', 'churn', 'onboarding', 'support', 'health',
  ],
  Sales: [
    'sales', 'ae', 'aes', 'seller', 'sellers', 'selling', 'revops', 'revenue', 'quota', 'pipeline',
    'forecast', 'forecasting', 'opportunity', 'opportunities', 'deal', 'deals', 'prospect',
    'prospecting', 'discovery', 'account', 'accounts', 'coaching', 'cro', 'cros', 'territory',
    'upsell', 'expansion',
  ],
  Marketing: [
    'marketing', 'campaign', 'campaigns', 'demand', 'abm', 'content', 'brand', 'event', 'events',
    'lead', 'leads', 'nurture', 'webinar',
  ],
}

/**
 * The categories we actually ship, stated outright.
 *
 * Keywords alone left a fifth of the built-in catalogue role-less: "Daily
 * Intelligence" and "Strategic Intelligence" name the OUTPUT, not the reader,
 * so nothing in them says "Sales" even though every template under them is a
 * seller's. This map is additive — it only ever grants roles on top of what the
 * keywords find, so an unknown category (a community submission, a custom one)
 * still falls through to matching.
 */
const CATEGORY_ROLES: Record<string, Role[]> = {
  // Agent templates and skills.
  'account monitoring': ['Sales', 'CSM'],
  'coaching & enablement': ['Sales'],
  'customer success': ['CSM'],
  'daily intelligence': ['Sales'],
  'pipeline & forecasting': ['Sales'],
  'platform enablement': ['IT'],
  'sales': ['Sales'],
  'sales ops': ['Sales'],
  'strategic intelligence': ['Sales'],
  // Flow templates, which carry their own vocabulary.
  'data operations': ['IT'],
  'docs & data': ['IT'],
  'engineering & design': ['IT'],
  'revenue operations': ['Sales'],
  'support operations': ['CSM'],
  // 'Starters' and 'Team Cadence' are deliberately absent: they are
  // audience-neutral, so claiming a role for them would be a guess.
}

/** Whole-word matcher, precompiled once per role. */
const ROLE_PATTERNS = ROLES.map((role) => ({
  role,
  pattern: new RegExp(`(?:^|[^a-z0-9])(?:${ROLE_KEYWORDS[role].join('|')})(?:[^a-z0-9]|$)`),
}))

export type RoleClassifiable = {
  category?: string | null
  tags?: string[] | null
  audience?: string[] | null
}

/** The classification text a role is read from — never the description. */
const haystack = (item: RoleClassifiable) =>
  [item.category ?? '', ...(item.tags ?? []), ...(item.audience ?? [])].join(' ').toLowerCase()

/** Every role an item belongs to, in ROLES order. Empty when nothing matches. */
export function rolesFor(item: RoleClassifiable): Role[] {
  const text = haystack(item)
  const stated = CATEGORY_ROLES[(item.category ?? '').trim().toLowerCase()] ?? []
  return ROLES.filter(
    (role) => stated.includes(role) || ROLE_PATTERNS.find((entry) => entry.role === role)!.pattern.test(text),
  )
}

/** Filter predicate for the Role dropdown. ALL_ROLES admits everything. */
export function hasRole(item: RoleClassifiable, role: string): boolean {
  if (role === ALL_ROLES) return true
  return rolesFor(item).includes(role as Role)
}
