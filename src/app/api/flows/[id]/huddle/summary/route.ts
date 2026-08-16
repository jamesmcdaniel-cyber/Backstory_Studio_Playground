import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { z } from 'zod'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assembleTranscript, summaryPrompt } from '@/lib/flows/huddle-transcript'
import { generateStructured } from '@/lib/llm/model-runner'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

const bodySchema = z.object({ sessionId: z.string().min(1) })

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A short paragraph of what was discussed.' },
    decisions: { type: 'array', items: { type: 'string' }, description: 'Concrete decisions or action items. Empty if none.' },
  },
  required: ['summary', 'decisions'],
  additionalProperties: false,
}

// POST /api/flows/[id]/huddle/summary — assemble a capture session's segments,
// summarise, persist the note, and DELETE the segments. Idempotent: the second
// caller finds the note (or no segments) and no model call is made. This is
// where posture A becomes real — after this, the verbatim record is gone.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-3)
  if (!id) throw new ApiError('Flow id is required')
  const { sessionId } = bodySchema.parse(await request.json())

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, name: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  // Second caller: the note already exists — return it, touch nothing.
  const existing = await prisma.huddleNote.findFirst({
    where: { sessionId, flowId: flow.id, organizationId: auth.organizationId },
  })
  if (existing) return { success: true, note: existing }

  const segments = await prisma.huddleSegment.findMany({
    where: { sessionId, flowId: flow.id, organizationId: auth.organizationId },
    orderBy: { startedAt: 'asc' },
  })
  const transcript = assembleTranscript(segments)
  if (!transcript) return { success: true, note: null, empty: true }

  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `huddle-summary:${auth.dbUser.id}`, limit: 10 })
  const system = `You turn meeting transcripts into concise, faithful team notes.\n\n${UNTRUSTED_DATA_RULE}`
  const user = summaryPrompt(flow.name, transcript)
  const raw = await generateStructured({ system, user, schema: SUMMARY_SCHEMA, schemaName: 'huddle_note', maxTokens: 1200 })
  recordEstimatedUsage(auth.organizationId, system, user, raw)

  let summary = ''
  let decisions: string[] = []
  try {
    const parsed = JSON.parse(raw) as { summary?: unknown; decisions?: unknown }
    summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    decisions = Array.isArray(parsed.decisions) ? parsed.decisions.filter((d): d is string => typeof d === 'string') : []
  } catch { /* fall through to the raw-transcript guard below */ }
  if (!summary) {
    // The model failed us but the segments are still there — keep them so a
    // retry can succeed, and say plainly that no note was produced.
    throw new ApiError('Could not summarise this huddle — try again.', 502, 'SUMMARY_FAILED')
  }

  const participants = Array.from(new Set(segments.map((s) => s.speakerName)))
  const startedAt = segments[0]?.startedAt ?? new Date()
  // create-then-delete in one transaction: if the note write fails the
  // segments survive for a retry; if it succeeds the verbatim record is gone.
  try {
    const note = await tenantTransaction(auth.organizationId, async (tx) => {
      const created = await tx.huddleNote.create({
        data: {
          flowId: flow.id,
          organizationId: auth.organizationId,
          sessionId,
          summary,
          decisions,
          participants,
          startedAt,
        },
      })
      await tx.huddleSegment.deleteMany({ where: { sessionId, flowId: flow.id, organizationId: auth.organizationId } })
      return created
    })
    return { success: true, note }
  } catch (error) {
    // Two "last" participants can race here; sessionId's unique constraint
    // picks the winner. The loser hands back the winner's note.
    const raced = await prisma.huddleNote.findFirst({
      where: { sessionId, flowId: flow.id, organizationId: auth.organizationId },
    })
    if (raced) return { success: true, note: raced }
    throw error
  }
}, { permission: 'flow.read' })
