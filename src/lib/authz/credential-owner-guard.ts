/**
 * Owner-liveness guard for user-owned credentials.
 *
 * Deprovisioning used to be identity-only: `isActive: false` plus a banned
 * Supabase session, with every credential row left intact and usable. The
 * revocation itself (src/lib/revoke-user-access.ts) removes those rows — but
 * correctness cannot depend on every current AND future deprovision path
 * remembering to call it. That is precisely how the original bug happened:
 * org-transfer.ts had the revocation logic and deactivation simply never
 * called it.
 *
 * So this is the invariant underneath: a credential whose owner is not an
 * active user is not RESOLVABLE, no matter which call site asks. A missed
 * deprovision path degrades to "unusable but not yet revoked upstream" instead
 * of a live hole.
 *
 * RELATIONSHIP TO THE TENANT GUARD (src/lib/tenant-guard.ts): same registry
 * shape, inverted mechanism. `assertOrgScoped` THROWS on an unscoped query.
 * This REWRITES args to inject a filter, because rejection would break every
 * legitimate read. Both are guardrails, not security boundaries; RLS remains
 * the structural fix.
 *
 * `systemPrisma` bypasses this, as it bypasses the tenant guard. That is
 * required: the revocation sweeper and src/lib/mcp/health-sweep.ts must see
 * these rows in order to clean them up.
 */

/**
 * Models carrying BOTH a `userId` and a credential. `userId: null` on these
 * means org-owned (a shared MCP server, a workspace Nango connection) and stays
 * usable — it belongs to the workspace and does not die with a person.
 *
 * DELIBERATELY ABSENT:
 *   - HttpCredential, IntegrationSecret — no userId at all. Workspace-owned;
 *     revoking them when one person leaves would break the org.
 *   - ApiKey — has a userId, but already fails closed at authentication
 *     (src/lib/public-api/auth.ts re-checks isActive). revokeUserAccess marks
 *     its rows revoked so inventories read correctly.
 */
export const OWNER_LIVENESS_MODELS: ReadonlySet<string> = new Set([
  'Integration',
  'PeopleAiConnection',
  'McpConnection',
  'NangoConnection',
])

/**
 * Reads that accept an arbitrary `where` and can therefore carry the filter.
 * Writes are absent on purpose — this layer prevents USE, not removal, and
 * filtering deletes would fight revokeUserAccess.
 */
const FILTERABLE_READS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

/** Reads whose `where` accepts only unique fields, so the filter cannot go in. */
const UNFILTERABLE_READS = new Set(['findUnique', 'findUniqueOrThrow'])

/** The filter itself: org-owned rows, or rows whose owner is still active. */
const OWNER_IS_LIVE = { OR: [{ userId: null }, { user: { is: { isActive: true } } }] } as const

export class UnfilterableCredentialReadError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Credential owner guard: ${model}.${operation} cannot carry the owner-liveness filter, ` +
        `because ${operation} accepts only unique fields in its where clause. ` +
        `Rewrite the call as findFirst with the same conditions — or, for a legitimate ` +
        `system path, use systemPrisma from '@/lib/prisma' with a justification comment.`,
    )
    this.name = 'UnfilterableCredentialReadError'
  }
}

/**
 * Inject the owner-liveness filter into a credential read.
 *
 * Returns `args` unchanged for anything outside the registry, and for writes.
 * Throws `UnfilterableCredentialReadError` on findUnique against a registry
 * model — silently passing those through would leave a hole exactly where the
 * People.ai OAuth tokens are read.
 */
export function applyOwnerLiveness(model: string | undefined, operation: string, args: unknown): unknown {
  if (!model || !OWNER_LIVENESS_MODELS.has(model)) return args
  if (UNFILTERABLE_READS.has(operation)) throw new UnfilterableCredentialReadError(model, operation)
  if (!FILTERABLE_READS.has(operation)) return args

  const record = (args ?? {}) as { where?: unknown }
  const where = record.where
  return {
    ...record,
    where: where ? { AND: [where, OWNER_IS_LIVE] } : OWNER_IS_LIVE,
  }
}
