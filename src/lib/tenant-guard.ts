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
 * Known limitations (accepted for a guardrail): the check is satisfied by an
 * organizationId key ANYWHERE in the where tree — a bare branch inside OR, or
 * NOT: { organizationId }, still passes despite matching cross-tenant rows;
 * nested writes issued through a parent operation (e.g. organization.update
 * with nested child writes) are not seen by the extension; $queryRaw/$executeRaw
 * are client-level and unguarded. These are deliberate-query shapes, not
 * accidental omissions — RLS remains the structural fix.
 */

// Org-carrying models with a REQUIRED organizationId (schema.prisma).
// User (nullable orgId, auth bootstrap) and Organization (the tenant row)
// are deliberately excluded. Transitively-scoped children (WorkflowStep,
// FlowRunStep, ExecutionMessage, WorkflowEvent) are excluded — they carry
// no organizationId column; scope them via relation filters when querying
// from user-facing code.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'AgentTask', 'AgentConnector', 'AgentMemory', 'AgentChatMessage', 'AgentChatSession',
  'Signal', 'SignalSubscription', 'CustomSignal', 'AgentExecution', 'Notification',
  'PushSubscription', 'AuditEvent', 'ApprovalRequest', 'AgentTemplate', 'Integration',
  'PeopleAiConnection', 'McpConnection', 'NangoConnection', 'IntegrationSecret',
  'HttpCredential',
  'Flow', 'FlowVersion', 'FlowRun', 'KnowledgeDocument', 'KnowledgeChunk', 'SharedSkill',
  'TemplateProposal', 'StoredFile', 'CatalogueSubmission',
])

const GUARDED_OPERATIONS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', 'count', 'aggregate', 'groupBy',
])

/** True when an `organizationId` key appears anywhere in the where tree with a defined value. */
export function whereHasOrgScope(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false
  if (Array.isArray(where)) return where.some(whereHasOrgScope)
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'organizationId' && value !== undefined) return true
    if (whereHasOrgScope(value)) return true
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
