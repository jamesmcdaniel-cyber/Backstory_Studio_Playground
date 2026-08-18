/**
 * Server-side ARRANGEMENT for journeys that cannot set up their own
 * preconditions through the UI.
 *
 * Almost nothing here should be needed. A journey test earns its keep by
 * driving the product the way a person does, and reaching around the product
 * into its database is how end-to-end suites rot into fixture-maintenance.
 * The one honest exception is a ceiling: the daily run cap is a REFUSAL, and a
 * refusal cannot be arranged through the surface that is being refused.
 *
 * ── Why absence is a loud skip, never a pass ──────────────────────────────
 * Every entry point returns null when E2E_DATABASE_URL is unset, and every
 * caller turns that null into `test.skip(reason)`. The alternative — quietly
 * proceeding without the arrangement — would leave a spec that still passes
 * while asserting nothing about the thing it is named after, which is strictly
 * worse than no spec at all.
 *
 * The connection is opened lazily and per-call: a run that never touches the
 * seed helpers never requires a database, so the ordinary browser suite has no
 * Postgres dependency at all.
 */
import type { PrismaClient } from '@prisma/client'
import { seedSkipReason } from './env'

let client: PrismaClient | null = null

/**
 * A Prisma client bound to the environment under test, or null when no
 * database URL was supplied.
 *
 * `datasourceUrl` rather than mutating process.env.DATABASE_URL: the suite may
 * be running beside a dev server in the same shell, and silently repointing a
 * shared variable is how a "test" deletes something real.
 */
export async function db(): Promise<PrismaClient | null> {
  if (seedSkipReason()) return null
  if (client) return client
  const { PrismaClient: Client } = await import('@prisma/client')
  client = new Client({ datasourceUrl: process.env.E2E_DATABASE_URL })
  return client
}

export async function disconnectDb(): Promise<void> {
  await client?.$disconnect()
  client = null
}

/**
 * Hand this person a fresh daily allowance, from now.
 *
 * Moves `User.runAllowanceResetAt` forward rather than deleting run rows.
 * Deleting is the tempting shortcut and the wrong one: run rows are the
 * workspace's execution history, a test has no business destroying records it
 * did not create, and `runWindowStart` already treats a later stamp as the
 * window start precisely so an allowance can be granted without rewriting
 * history. The stamp can only move the window FORWARD (see the "later of"
 * rule in src/lib/usage/free-tier-limits.ts), so this cannot widen anyone's cap.
 */
export async function grantFreshRunAllowance(userId: string): Promise<boolean> {
  const prisma = await db()
  if (!prisma) return false
  await prisma.user.update({ where: { id: userId }, data: { runAllowanceResetAt: new Date() } })
  return true
}

/**
 * Fill this person's daily flow-run allowance so the next start is refused.
 *
 * Writes `count` FlowRun rows dated inside the current window, which is exactly
 * what `checkDailyRunAllowance` counts. They are marked `succeeded` and carry a
 * recognisable trigger so a human reading the workspace's execution log can
 * tell instantly that a test wrote them.
 */
export async function fillDailyFlowRunAllowance(args: {
  organizationId: string
  userId: string
  flowId: string
  count: number
}): Promise<boolean> {
  const prisma = await db()
  if (!prisma) return false
  await prisma.flowRun.createMany({
    data: Array.from({ length: args.count }, () => ({
      flowId: args.flowId,
      organizationId: args.organizationId,
      userId: args.userId,
      status: 'succeeded',
      trigger: { type: 'e2e-allowance-fill' },
      startedAt: new Date(),
      finishedAt: new Date(),
    })),
  })
  return true
}

/** Remove the synthetic rows written by {@link fillDailyFlowRunAllowance}. */
export async function clearSeededRuns(flowId: string): Promise<void> {
  const prisma = await db()
  if (!prisma) return
  await prisma.flowRun.deleteMany({
    where: { flowId, trigger: { equals: { type: 'e2e-allowance-fill' } } },
  })
}

/**
 * Delete flows this suite created, identified by the name prefix every spec
 * uses. Scoped to one workspace and one prefix so it can never reach a flow a
 * person made.
 */
export async function deleteFlowsNamed(organizationId: string, prefix: string): Promise<void> {
  const prisma = await db()
  if (!prisma) return
  await prisma.flow.deleteMany({ where: { organizationId, name: { startsWith: prefix } } })
}

/** Revoke invitations this suite created, so a rerun is not blocked by its own leftovers. */
export async function revokeInvitationsFor(organizationId: string, emailPrefix: string): Promise<void> {
  const prisma = await db()
  if (!prisma) return
  await prisma.invitation.deleteMany({ where: { organizationId, email: { startsWith: emailPrefix } } })
}
