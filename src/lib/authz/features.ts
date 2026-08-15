/**
 * Feature entitlements: what a person has switched ON, as distinct from what
 * their role permits.
 *
 * These are different questions and conflating them is a common mistake. A
 * PERMISSION says "an admin may manage integrations" — it is about authority
 * and is the same for every workspace. A FEATURE says "this workspace bought
 * voice huddles" or "this team is piloting the flow copilot" — it is about
 * what has been enabled, varies per customer, and changes without anyone's
 * authority changing.
 *
 * Modelling features as permissions would mean inventing a role per
 * combination of purchased features, which is how role systems become
 * unmaintainable.
 *
 * ── Three scopes, because that is how the request arrives ──────────────────
 *
 * Pilots go to a TEAM, exceptions go to a PERSON, and the plan goes to the
 * WORKSPACE. A single scope would force re-granting a whole team one user at a
 * time, and would lose the reason it was granted.
 *
 * ── Deny beats grant ──────────────────────────────────────────────────────
 *
 * An explicit `enabled: false` at any scope wins over every grant. Without it,
 * the only way to exclude one person from a workspace-wide feature is to stop
 * granting it to everyone — so the exception silently becomes an argument for
 * turning the feature off entirely.
 */

/**
 * Every feature that can be granted. A registry rather than free strings so a
 * typo is a compile error instead of a silently-never-enabled feature — the
 * failure mode of string-keyed flags, and one that presents as "the feature is
 * broken" rather than "the flag name is wrong".
 */
export const FEATURES = [
  'flows.copilot',
  'flows.code_steps',
  'agents.multi_agent',
  'huddles.voice',
  'knowledge.upload',
  'catalogue.publish',
  'api.public_access',
  'templates.auto_generation',
  'peopleai.sales_ai',
] as const

export type Feature = (typeof FEATURES)[number]

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value)
}

/**
 * Features every workspace has without a grant.
 *
 * The registry is not a paywall by default: a feature added here without a
 * default is OFF for everyone, which would silently disable working
 * functionality the moment it is listed. Anything already generally available
 * belongs in this set at the same time it joins the registry.
 */
export const DEFAULT_FEATURES: ReadonlySet<Feature> = new Set<Feature>([
  'flows.copilot',
  'flows.code_steps',
  'knowledge.upload',
])

export type GrantScope = 'organization' | 'team' | 'user'

export interface FeatureGrantRow {
  feature: string
  enabled: boolean
  teamId: string | null
  userId: string | null
}

export function scopeOf(grant: FeatureGrantRow): GrantScope {
  if (grant.userId) return 'user'
  if (grant.teamId) return 'team'
  return 'organization'
}

/**
 * Resolve the features one person holds.
 *
 * Pure — the caller supplies the grants and the person's team ids — so the
 * precedence rules are testable without a database, and so this can be called
 * once per request against an already-loaded set rather than issuing its own
 * queries.
 */
export function resolveFeatures(params: {
  grants: readonly FeatureGrantRow[]
  userId: string
  teamIds: readonly string[]
}): Set<Feature> {
  const teams = new Set(params.teamIds)
  const enabled = new Set<Feature>(DEFAULT_FEATURES)
  const denied = new Set<Feature>()

  for (const grant of params.grants) {
    if (!isFeature(grant.feature)) continue

    // A grant scoped to another person or another team says nothing about this
    // one. Filtering here rather than in the query keeps the precedence rules
    // in one readable place.
    if (grant.userId && grant.userId !== params.userId) continue
    if (grant.teamId && !teams.has(grant.teamId)) continue

    if (grant.enabled) enabled.add(grant.feature)
    else denied.add(grant.feature)
  }

  // Applied last, so a deny at ANY scope beats a grant at any other. A
  // narrower-scope-wins rule reads as more sophisticated but produces the
  // wrong answer for the case that matters: a workspace-wide "off" for a
  // withdrawn feature must not be re-enabled by a stale team pilot grant.
  for (const feature of denied) enabled.delete(feature)

  return enabled
}

/** Whether a resolved set carries a feature. Trivial, but names the intent. */
export function hasFeature(features: ReadonlySet<Feature>, feature: Feature): boolean {
  return features.has(feature)
}
