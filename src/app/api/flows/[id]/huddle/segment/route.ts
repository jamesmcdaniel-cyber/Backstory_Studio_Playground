import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { transcribeSegment, transcriptionAvailable } from '@/lib/flows/huddle-transcribe'
import { rateLimit } from '@/lib/ratelimit'

// Opus voice at ~180KB/min means a 2-minute segment is well under 1MB; 5MB
// leaves headroom for other codecs without letting anyone stream us a movie.
const SEGMENT_MAX_BYTES = 5_000_000

// POST /api/flows/[id]/huddle/segment — one client's two-minute audio chunk.
// The audio is transcribed IN MEMORY and discarded; only the text is stored
// (see the huddle-notes spec's retention posture). Gated on flow.read: anyone
// who can be in the huddle can contribute to its notes.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-3)
  if (!id) throw new ApiError('Flow id is required')
  if (!transcriptionAvailable({ OPENAI_API_KEY: process.env.OPENAI_API_KEY })) {
    throw new ApiError('Transcription is not configured for this workspace.', 503, 'TRANSCRIPTION_UNAVAILABLE')
  }
  // A client uploads every ~2 minutes; 10/min absorbs the final flush plus a
  // retry without letting a loop hammer the transcription vendor on our key.
  const limited = await rateLimit(`huddle-segment:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many segments — slow down.', 429, 'RATE_LIMITED')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const form = await request.formData().catch(() => null)
  const file = form?.get('audio')
  const sessionId = String(form?.get('sessionId') ?? '')
  const startedAtRaw = String(form?.get('startedAt') ?? '')
  const startedAt = new Date(startedAtRaw)
  if (!(file instanceof Blob) || !sessionId || Number.isNaN(startedAt.getTime())) {
    throw new ApiError('audio, sessionId and startedAt are required', 400, 'BAD_REQUEST')
  }
  if (file.size > SEGMENT_MAX_BYTES) throw new ApiError('Audio segment too large.', 400, 'FILE_TOO_LARGE')

  const audio = new Uint8Array(await file.arrayBuffer())
  const text = await transcribeSegment({
    audio,
    mimeType: file.type || 'audio/webm',
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  })
  // Transcription failed (or was silence): report so the client can warn, but
  // this is a lost segment, not an error state — the summary is built from
  // whatever survived.
  if (text === null) return { success: true, transcribed: false }
  if (!text) return { success: true, transcribed: true, empty: true }

  await prisma.huddleSegment.create({
    data: {
      flowId: flow.id,
      organizationId: auth.organizationId,
      sessionId,
      speakerName: auth.dbUser.name || auth.dbUser.email || 'Someone',
      text,
      startedAt,
    },
  })
  return { success: true, transcribed: true }
// Multipart audio segment — raised above the wrapper's 1 MB JSON default to this
// route's own SEGMENT_MAX_BYTES ceiling (plus multipart framing slack).
}, { permission: 'flow.read', maxBodyBytes: SEGMENT_MAX_BYTES + 100_000 })
