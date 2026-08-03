/**
 * Tenant-isolation guardrail for the shared Prisma client.
 *
 * Every read/update/delete on an org-carrying model must scope by
 * organizationId — this codebase's oldest invariant, previously enforced
 * only by convention. The guard turns a silently-unscoped query (a
 * cross-tenant data leak waiting to happen) into a loud error at the call
 * site. It is a guardrail, not a security boundary: Postgres RLS remains
 * the eventual structural fix.
 *
 * Legitimate org-less system paths (cron sweeps, reapers, tenant
 * resolution, worker-internal id-keyed writes) use `systemPrisma` from
 * src/lib/prisma.ts, with a one-line justification comment at each site.
 *
 * WHAT COUNTS AS SCOPED
 *
 * The question is not "does organizationId appear somewhere" — it is "is EVERY
 * row this query can match constrained to the org". Those differ in exactly the
 * places that leak:
 *
 *   - `OR: [{ organizationId }, { somethingElse }]` — the second branch matches
 *     rows in ANY org. Scoped only if every branch is scoped.
 *   - `NOT: { organizationId }` — matches every OTHER org. Never scope.
 *   - `organizationId: { not: X }` — same thing, spelled differently.
 *   - a to-many `some:` filter — proves a RELATED row is in the org, not that
 *     the matched row is.
 *
 * The earlier version accepted all four, because it searched the whole where
 * tree for the key. It now walks the tree as the boolean expression it actually
 * is. Positive to-one relation filters (`{ execution: { is: { organizationId } } }`,
 * or its bare-object shorthand) DO carry scope — that is how the transitively
 * scoped children (WorkflowStep, FlowRunStep, ExecutionMessage, WorkflowEvent)
 * are meant to be queried.
 *
 * Remaining limitations, unchanged: nested writes issued through a parent
 * operation (e.g. organization.update with nested child writes) are not seen by
 * the extension, and $queryRaw/$executeRaw are client-level and unguarded (those
 * sites are covered by a separate static test). RLS remains the structural fix;
 * this is a guardrail, not a security boundary.
 */

// Org-carrying models with a REQUIRED organizationId (schema.prisma).
// User (nullable orgId, auth bootstrap) and Organization (the tenant row)
// are deliberately excluded. Transitively-scoped children (WorkflowStep,
// FlowRunStep, ExecutionMessage, WorkflowEvent) are excluded — they carry
// no organizationId column; scope them via relation filters when querying
// from user-facing code.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'Invitation', 'OrganizationDomain', 'ScimToken', 'ApiKey',
  'AgentTask', 'AgentConnector', 'AgentMemory', 'AgentChatMessage', 'AgentChatSession',
  'Signal', 'SignalSubscription', 'CustomSignal', 'AgentExecution', 'Notification',
  'PushSubscription', 'AuditEvent', 'ApprovalRequest', 'AgentTemplate', 'Integration',
  'PeopleAiConnection', 'McpConnection', 'NangoConnection', 'IntegrationSecret',
  'HttpCredential',
  'Flow', 'FlowTemplate', 'FlowTemplateVersion', 'FlowVersion', 'FlowRun',
  'HuddleSegment', 'HuddleNote', 'KnowledgeDocument', 'KnowledgeChunk', 'SharedSkill',
  'TemplateProposal', 'StoredFile', 'CatalogueSubmission', 'FlowWebhookReceipt', 'OutboxEvent',
])

const GUARDED_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
])

/**
 * True when a scalar filter on organizationId CONSTRAINS the match rather than
 * negating it. A literal id, `{ equals }` and `{ in }` constrain; `{ not }` does
 * the opposite. `null` is allowed through: organizationId is NOT NULL on every
 * org-carrying model, so it matches nothing — harmless, not a leak.
 */
function constrainsOrg(value: unknown): boolean {
  if (value === undefined) return false
  if (value === null) return true
  if (typeof value !== 'object') return true
  const filter = value as Record<string, unknown>
  if ('not' in filter) return false
  return 'equals' in filter || 'in' in filter
}

/** True when EVERY row the where clause can match is constrained to an org. */
export function whereHasOrgScope(where: unknown): boolean {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return false
  const node = where as Record<string, unknown>

  if ('organizationId' in node && constrainsOrg(node.organizationId)) return true

  // AND is a conjunction: one scoped conjunct constrains the whole match.
  const and = node.AND
  if (Array.isArray(and) ? and.some(whereHasOrgScope) : whereHasOrgScope(and)) return true

  // OR is a disjunction: an unscoped branch widens the match to other orgs, so
  // every branch has to carry scope. An empty OR matches nothing in Prisma, but
  // treat it as unscoped rather than reason about that here.
  const or = node.OR
  if (Array.isArray(or)) {
    if (or.length > 0 && or.every(whereHasOrgScope)) return true
  } else if (whereHasOrgScope(or)) return true

  // NOT is deliberately never traversed — scope inside a negation excludes an
  // org instead of selecting one.
  for (const [key, value] of Object.entries(node)) {
    if (key === 'organizationId' || key === 'AND' || key === 'OR' || key === 'NOT') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const relation = value as Record<string, unknown>
    // To-one relation filter, explicit form. `isNot` is a negation; `some` only
    // proves a related row is in the org; `every` is vacuously true on an empty
    // relation. None of those constrain the matched row, so only `is` counts.
    if ('is' in relation) {
      if (whereHasOrgScope(relation.is)) return true
      continue
    }
    if ('isNot' in relation || 'some' in relation || 'every' in relation || 'none' in relation) continue
    // Bare-object shorthand for a to-one relation ({ execution: { organizationId } }).
    // Scalar filter objects ({ id: { in: [...] } }) fall through to false here,
    // since they carry no organizationId and no relation keys.
    if (whereHasOrgScope(relation)) return true
  }
  return false
}

export function assertOrgScoped(model: string, operation: string, args: unknown): void {
  if (!ORG_SCOPED_MODELS.has(model)) return
  if (!GUARDED_OPERATIONS.has(operation)) return
  const where = (args as { where?: unknown } | undefined)?.where
  if (whereHasOrgScope(where)) return
  throw new Error(
    `Tenant guard: ${model}.${operation} ran without organizationId in its where clause. ` +
      `Scope the query (add organizationId, or a relation filter that carries it), ` +
      `or — for a legitimate system-wide path — use systemPrisma from '@/lib/prisma' with a justification comment.`,
  )
}
