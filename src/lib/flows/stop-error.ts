/**
 * How a Stop step ends the run.
 *
 * Ours has always ended it QUIETLY — later steps skipped, the run not a
 * failure. n8n's Stop and Error always raises, which is a different thing: one
 * says "we are done here", the other says "this is wrong, fail the run and tell
 * someone". A flow that detects a bad state needs the second, and had no way to
 * say it.
 *
 * Opt-in, so every flow saved before this keeps ending quietly. Pure: the
 * interpreter decides what to do, this decides what was asked for.
 */

export type StopData = {
  reason?: string
  errorType?: 'errorMessage' | 'errorObject'
  errorMessage?: string
  errorObject?: string
}

export type StopOutcome =
  | { kind: 'quiet'; message: string }
  | { kind: 'error'; message: string; detail?: unknown }

/** The default message, so a raised error is never blank. */
export const DEFAULT_STOP_ERROR = 'The flow stopped with an error.'

export function stopOutcome(data: StopData): StopOutcome {
  if (data.errorType === 'errorMessage') {
    return { kind: 'error', message: data.errorMessage?.trim() || data.reason?.trim() || DEFAULT_STOP_ERROR }
  }

  if (data.errorType === 'errorObject') {
    const raw = data.errorObject?.trim()
    if (!raw) return { kind: 'error', message: DEFAULT_STOP_ERROR }
    try {
      const parsed = JSON.parse(raw)
      // A `message` inside the object is what the caller wants surfaced; the
      // whole object still travels as the detail.
      const message =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : DEFAULT_STOP_ERROR
      return { kind: 'error', message, detail: parsed }
    } catch {
      // Unparseable JSON is still a deliberate stop — failing to fail would be
      // the worst outcome here, so it raises with the text as written.
      return { kind: 'error', message: raw }
    }
  }

  return { kind: 'quiet', message: data.reason?.trim() || 'Flow stopped.' }
}
