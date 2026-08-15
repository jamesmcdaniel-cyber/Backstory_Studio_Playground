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

import { Prisma } from '@prisma/client'

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
  'HttpCredential',
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

/**
 * The filter, per model — because the right one depends on whether `userId` is
 * nullable, and it is not uniform across the registry.
 *
 * `Integration` and `PeopleAiConnection` require `userId`; `McpConnection` and
 * `NangoConnection` allow null (meaning org-owned). Prisma REJECTS a
 * `{ userId: null }` filter on a required field outright — "Argument `userId` is
 * missing" — so a single shared filter cannot work, and hardcoding two lists
 * would silently rot the first time a column's nullability changes.
 *
 * Derived from the DMMF at module load so it tracks the schema by construction.
 */
const OWNER_IS_LIVE_BY_MODEL: ReadonlyMap<string, object> = new Map(
  [...OWNER_LIVENESS_MODELS].map((modelName) => {
    const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName)
    const userId = model?.fields.find((field) => field.name === 'userId')
    if (!userId) {
      throw new Error(
        `Credential owner guard: ${modelName} is registered but has no userId field. ` +
          `Remove it from OWNER_LIVENESS_MODELS, or register a model that is actually user-owned.`,
      )
    }
    // The filter is a JOIN, so the relation must exist — a bare userId column is
    // not enough. NangoConnection carried exactly that shape (a dangling userId
    // with no relation and no foreign key) and silently could not be filtered.
    if (!model?.fields.some((field) => field.name === 'user' && field.kind === 'object')) {
      throw new Error(
        `Credential owner guard: ${modelName} has a userId column but no \`user\` relation, ` +
          `so its owner's liveness cannot be joined. Add the relation (with a foreign key) ` +
          `before registering it — a userId that references nothing cannot be enforced.`,
      )
    }
    const ownerIsActive = { user: { is: { isActive: true } } }
    // A required userId cannot be null, so the org-owned branch is not merely
    // unnecessary there — it is invalid.
    return [modelName, userId.isRequired ? ownerIsActive : { OR: [{ userId: null }, ownerIsActive] }]
  }),
)

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

  const ownerIsLive = OWNER_IS_LIVE_BY_MODEL.get(model)!
  const record = (args ?? {}) as { where?: unknown }
  const where = record.where
  return {
    ...record,
    where: where ? { AND: [where, ownerIsLive] } : ownerIsLive,
  }
}
