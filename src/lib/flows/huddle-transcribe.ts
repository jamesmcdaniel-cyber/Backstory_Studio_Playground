import { captureError } from '@/lib/observability/sentry'

export type TranscribeEnv = { OPENAI_API_KEY?: string }

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const TRANSCRIBE_TIMEOUT_MS = 60_000

/** The capture toggle is disabled (with an explanation) when this is false,
 *  so nobody records a call whose transcription was never going to happen. */
export function transcriptionAvailable(env: TranscribeEnv): boolean {
  return Boolean(env.OPENAI_API_KEY)
}

/**
 * Transcribes one uploaded audio segment. Returns the text, or null on any
 * failure — one bad segment must not fail the route, and the summary is built
 * from whatever survived. The audio exists only in memory here; it is never
 * written to storage.
 */
export async function transcribeSegment(params: {
  audio: Uint8Array
  mimeType: string
  env: TranscribeEnv
  fetchImpl?: typeof fetch
}): Promise<string | null> {
  const key = params.env.OPENAI_API_KEY
  if (!key) return null
  try {
    const form = new FormData()
    form.append('model', 'whisper-1')
    form.append('file', new Blob([params.audio as BlobPart], { type: params.mimeType }), 'segment.webm')
    const doFetch = params.fetchImpl ?? fetch
    const response = await doFetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`transcription responded ${response.status}`)
    const data = (await response.json()) as { text?: unknown }
    return typeof data.text === 'string' ? data.text.trim() : null
  } catch (error) {
    captureError(error, { scope: 'flows.huddle.transcribe' })
    return null
  }
}
