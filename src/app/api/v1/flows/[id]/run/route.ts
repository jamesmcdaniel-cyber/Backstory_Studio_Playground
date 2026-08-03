import { z } from 'zod'
import { startFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:run')
  if (auth instanceof Response) return auth
  const id = new URL(request.url).pathname.split('/').at(-2) ?? ''
  const flow = await prisma.flow.findFirst({ where: { id, organizationId: auth.organizationId }, select: { id: true } })
  if (!flow) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  const limited = await rateLimit(`public-flow-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000, failureMode: 'closed' })
  if (!limited.ok) return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Too many flow runs.' } }, 429)
  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.userId)
  if (budget.over) return publicApiJson({ error: { code: 'BUDGET_EXCEEDED', message: 'Monthly token budget reached.' } }, 429)
  const body = z.object({ input: z.unknown().optional() }).parse(await request.json().catch(() => ({})))
  const run = await startFlowExecution({ flowId: id, organizationId: auth.organizationId, userId: auth.userId, input: parseFlowInput(body.input) })
  return publicApiJson({ data: run }, 202)
}
