/**
 * OAuth scope governance.
 *
 * Scopes were entirely ungoverned: Nango scopes live in their dashboard,
 * People.ai's came from a free-text env var, and MCP connections took whatever
 * the server advertised. Nothing recorded what was actually granted, so
 * "are OAuth scopes minimized?" had no answer — an integration that asked for
 * read and one that asked for full write access produced identical rows.
 *
 * ── Why this flags rather than blocks, mostly ──────────────────────────────
 *
 * A hard reject on every unrecognised scope would be security theatre with an
 * outage attached: providers rename scopes, add granular ones, and return
 * scopes nobody requested. Blocking on an incomplete catalogue would break
 * working integrations for a policy we cannot yet state correctly.
 *
 * So the rule is split by whether we have actually declared a policy:
 *
 *   - Provider WITH a declared policy → excess scopes are a violation, and the
 *     connection is refused. We said what this integration needs; more than
 *     that is a real finding.
 *   - Provider WITHOUT one → scopes are recorded and classified, never
 *     blocked. The write-scope heuristic still fires, so an unknown provider
 *     handing us write access is visible on the credentials page the same day.
 *
 * Adding a provider to POLICY is therefore a deliberate act that turns
 * monitoring into enforcement for that provider, one at a time.
 */

export interface ScopePolicy {
  /** Everything this integration is permitted to hold. */
  allowed: string[]
  /** What the product genuinely needs; the rest of `allowed` is opt-in. */
  minimum: string[]
  /** Why this set — read at review time, when the original context is gone. */
  rationale: string
}

/**
 * Declared per-provider policy. An entry here means ENFORCEMENT: a grant
 * carrying anything outside `allowed` is refused.
 *
 * Deliberately small. Each entry should be added when someone has actually
 * checked what the integration calls, not to make the map look complete.
 */
export const SCOPE_POLICY: Record<string, ScopePolicy> = {
  people_ai: {
    allowed: ['mcp:read', 'mcp:tools', 'openid', 'profile', 'email', 'offline_access'],
    minimum: ['mcp:read', 'mcp:tools'],
    rationale:
      'Sales AI is read-only for us: agents ask questions about accounts and opportunities and ' +
      'never write back. offline_access is required for the refresh token.',
  },
}

/**
 * Scope fragments that indicate the ability to CHANGE something in a third-party
 * system. Provider-agnostic on purpose — it has to fire for providers with no
 * policy entry, which is the case this exists to cover.
 *
 * False positives are acceptable here (the result is a review prompt, never a
 * block); false negatives are not.
 */
const WRITE_SCOPE_FRAGMENTS = [
  'write',
  'admin',
  'manage',
  'delete',
  'create',
  'update',
  'modify',
  'send',
  'post',
  'edit',
  'full',
  'owner',
  'control',
  'issue',
  'publish',
]

/** Scopes that grant nothing beyond identifying the user. */
const IDENTITY_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access'])

export type ScopeRisk = 'identity' | 'read' | 'write'

export function classifyScope(scope: string): ScopeRisk {
  const normalized = scope.toLowerCase()
  if (IDENTITY_SCOPES.has(normalized)) return 'identity'
  // Checked on the whole string: providers spell write access as `chat:write`,
  // `files.write`, `Mail.Send` and `repo` alike, and only substring matching
  // catches that spread.
  if (WRITE_SCOPE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return 'write'
  return 'read'
}

export interface ScopeReview {
  /** Normalised scopes actually granted. */
  granted: string[]
  /** Granted scopes that let the integration change something. */
  writeScopes: string[]
  /** Granted scopes outside a declared policy. Always empty without a policy. */
  excessScopes: string[]
  /** True when a policy exists for this provider — i.e. excess is enforceable. */
  policyDeclared: boolean
  /** True when the grant may be stored. False only ever for a declared policy. */
  permitted: boolean
  /**
   * Whether a human should look at this. True for any write scope, or any
   * excess — a grant can be permitted and still deserve a second look.
   */
  needsReview: boolean
}

/**
 * Classify a grant against policy.
 *
 * Returns a verdict rather than throwing so the caller decides what a violation
 * means in its context — a connect route refuses, a backfill records.
 */
export function reviewScopes(provider: string | null | undefined, granted: string[]): ScopeReview {
  const normalized = [...new Set(granted.map((scope) => scope.trim()).filter(Boolean))].sort()
  const policy = provider ? SCOPE_POLICY[provider] : undefined

  const writeScopes = normalized.filter((scope) => classifyScope(scope) === 'write')
  const excessScopes = policy
    ? normalized.filter((scope) => !policy.allowed.includes(scope))
    : []

  return {
    granted: normalized,
    writeScopes,
    excessScopes,
    policyDeclared: Boolean(policy),
    permitted: excessScopes.length === 0,
    needsReview: writeScopes.length > 0 || excessScopes.length > 0,
  }
}

/**
 * Human-readable reason a grant was refused, for the error shown at connect
 * time. Names the offending scopes: "it asked for too much" is unactionable,
 * and the person reconnecting is usually the one who can narrow the request.
 */
export function scopeViolationMessage(provider: string, review: ScopeReview): string {
  const policy = SCOPE_POLICY[provider]
  return (
    `This connection requested scopes beyond what ${provider} is permitted to hold here: ` +
    `${review.excessScopes.join(', ')}. Allowed: ${policy?.allowed.join(', ') ?? 'none'}. ` +
    `${policy?.rationale ?? ''}`.trim()
  )
}
