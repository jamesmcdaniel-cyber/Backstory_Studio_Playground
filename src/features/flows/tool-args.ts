function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Thread-binding for Slack replies (Task 9 of the activity-event substrate
 * plan): a run started by an `activity`/`slack` trigger whose event was a
 * Slack message carries `trigger.subject` (see dispatchActivityEvent,
 * src/lib/activity/dispatch.ts) with `threadTs` (set when the triggering
 * message was itself a thread reply) and `ts` (the message's own timestamp —
 * see normalizeSlackEvent, src/lib/activity/normalize.ts). A `slack_post_
 * message` step that doesn't set its own `thread_ts` defaults to replying IN
 * THAT THREAD: `threadTs` when the trigger was already inside one, else the
 * triggering message's own `ts` (which starts a fresh thread off it). An
 * explicit `thread_ts` on the step always wins — this only fills in what the
 * step left unset (undefined, null, or empty string).
 */
export function applySlackThreadDefault(
  toolName: string,
  args: Record<string, unknown>,
  trigger: unknown,
): Record<string, unknown> {
  if (toolName !== 'slack_post_message') return args
  const existing = args.thread_ts
  if (typeof existing === 'string' ? existing.trim() !== '' : existing != null) return args
  const subject = isRecord(trigger) && isRecord(trigger.subject) ? trigger.subject : undefined
  if (!subject) return args
  const threadTs = typeof subject.threadTs === 'string' && subject.threadTs ? subject.threadTs : undefined
  const ts = typeof subject.ts === 'string' && subject.ts ? subject.ts : undefined
  const defaultThread = threadTs ?? ts
  return defaultThread ? { ...args, thread_ts: defaultThread } : args
}

export function prepareToolArgs(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') throw new Error('Tool arguments must be a JSON object.')
  try {
    const parsed = JSON.parse(value || '{}')
    if (isRecord(parsed)) return parsed
  } catch {
    throw new Error('Tool arguments are not valid JSON after template substitution.')
  }
  throw new Error('Tool arguments must be a JSON object after template substitution.')
}
