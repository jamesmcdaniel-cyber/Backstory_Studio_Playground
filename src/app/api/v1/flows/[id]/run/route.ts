import { z } from 'zod'
import { startFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:run')
  if (auth instanceof Response) return auth
  const id = new URL(request.url).pathname.split('/').at(-2) ?? ''
  // Visibility gate: a private flow may only be run by its owner, exactly as in
  // the session route (/api/flows/[id]/execute) and the sibling v1 read/write
  // routes. This route filtered on organizationId alone, so a key could execute
  // a colleague's private flow — firing its side effects under that workspace's
  // credentials — even though it could not read, edit, or delete it.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.userId) },
    select: { id: true },
  })
  if (!flow) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  const limited = await rateLimit(`public-flow-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Too many flow runs.' } }, 429)
  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.userId)
  if (budget.over) return publicApiJson({ error: { code: 'BUDGET_EXCEEDED', message: 'Monthly token budget reached.' } }, 429)
  const body = z.object({ input: z.unknown().optional() }).parse(await request.json().catch(() => ({})))
  const run = await startFlowExecution({ flowId: id, organizationId: auth.organizationId, userId: auth.userId, input: parseFlowInput(body.input) })
  return publicApiJson({ data: run }, 202)
}
