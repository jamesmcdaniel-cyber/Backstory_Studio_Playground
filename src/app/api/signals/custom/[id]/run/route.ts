import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { getPeopleAiReadClient } from '@/lib/peopleai/client'
import { askSalesAiAboutAccount, askSalesAiAboutOpportunity, findAccountId } from '@/lib/peopleai/salesai-facts'
import { cacheGet, cacheSet } from '@/lib/cache'
import { indexCustomSignalResult } from '@/lib/rag/indexer'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Run a custom signal against a target: resolve the rep's People.ai client
 * (their own connection first, org service fallback), ask the saved question via
 * ask_sales_ai_about_account/opportunity, cache the answer (15m, per rep), and
 * index it into graph-RAG so agents can use it.
 */

const RUN_TTL_MS = 15 * 60 * 1000
const runSchema = z.object({
  // Account name or numeric People.ai id (account scope); numeric opportunity id
  // (opportunity scope).
  target: z.string().trim().min(1).max(200),
})

function signalIdFromPath(request: NextRequest): string {
  const segments = request.nextUrl.pathname.split('/')
  // .../signals/custom/<id>/run
  const id = segments[segments.indexOf('custom') + 1]
  if (!id || id === 'run') throw new ApiError('Signal id is required')
  return id
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = signalIdFromPath(request)
  // Guard the parse: a bad/empty body should be a 400 (zod), not a 500.
  const { target } = runSchema.parse(await request.json().catch(() => ({})))

  const signal = await prisma.customSignal.findFirst({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  if (!signal) throw new ApiError('Signal not found', 404, 'NOT_FOUND')

  const client = await getPeopleAiReadClient(auth.dbUser.id, auth.organizationId)
  if (!client) throw new ApiError('People.ai is not connected', 503, 'PEOPLE_AI_UNAVAILABLE')

  const numeric = /^\d+$/.test(target) ? Number(target) : null
  let accountId: string | null = null
  let opportunityId: string | null = null
  let answer = ''

  if (signal.scope === 'opportunity') {
    if (numeric == null) throw new ApiError('Enter a numeric opportunity id for an opportunity signal')
    opportunityId = String(numeric)
    const key = `sig:${auth.dbUser.id}:${signal.id}:opp:${numeric}`
    answer = (await cacheGet<string>(key)) ?? ''
    if (!answer) {
      answer = await askSalesAiAboutOpportunity(client, numeric, signal.question)
      if (answer) await cacheSet(key, answer, RUN_TTL_MS)
    }
  } else {
    const resolved = numeric ?? (await findAccountId(client, target))
    if (resolved == null) throw new ApiError(`Could not find account "${target}"`, 404, 'NOT_FOUND')
    accountId = String(resolved)
    const key = `sig:${auth.dbUser.id}:${signal.id}:acct:${resolved}`
    answer = (await cacheGet<string>(key)) ?? ''
    if (!answer) {
      answer = await askSalesAiAboutAccount(client, resolved, signal.question)
      if (answer) await cacheSet(key, answer, RUN_TTL_MS)
    }
  }

  if (!answer) throw new ApiError('SalesAI returned no answer for this target.', 502, 'PEOPLE_AI_EMPTY')

  // Fire-and-forget: make the result agent-usable via the graph. Best-effort.
  void indexCustomSignalResult({
    organizationId: auth.organizationId,
    ownerUserId: auth.dbUser.id,
    signalId: signal.id,
    name: signal.name,
    question: signal.question,
    answer,
    accountId,
    opportunityId,
  }).catch(() => undefined)

  return { success: true, answer, accountId, opportunityId }
}, { permission: 'agent.run' })
