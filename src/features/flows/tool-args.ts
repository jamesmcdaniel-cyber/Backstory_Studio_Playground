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

/**
 * Chain-depth producer for Slack (ruling 4 of the activity-event substrate
 * plan): a flow-authored Slack post stamps Slack's own `chat.postMessage`
 * `metadata` field (`{ event_type, event_payload }`) with the POSTING run's
 * own `chainDepth` — the same field `chainDepthFromMetadata`
 * (src/lib/activity/normalize.ts) already reads back out when that post
 * itself becomes a live Slack event. This is what lets a flow-triggered
 * reply chain be depth-capped (`ACTIVITY_CHAIN_DEPTH_CAP`,
 * src/lib/activity/dispatch.ts) instead of only relying on `selfOrigin`
 * (which only catches the bot replying to ITSELF, not two different flows
 * volleying through Slack posts).
 *
 * Only stamped when `run.trigger` actually carries a `chainDepth` — i.e. the
 * run was itself started from an `activity`/`slack` trigger
 * (`dispatchActivityEvent` sets `trigger.chainDepth: event.chainDepth + 1` on
 * every run it starts). A flow triggered manually, by schedule, or by
 * webhook has no such field, and this deliberately omits `metadata` entirely
 * for it — there's no depth to propagate, and an absent chain never counts
 * toward the cap.
 *
 * The stamped value is the RUN's own chainDepth as-is, not incremented again
 * here: `dispatchActivityEvent` is what increments (event.chainDepth + 1)
 * when it turns a NEW event into the NEXT run, so the value written here
 * must be "this run's depth," matching what the receiver would have derived
 * had the run's trigger.chainDepth simply been echoed straight through.
 */
export function applySlackChainDepthMetadata(
  toolName: string,
  args: Record<string, unknown>,
  trigger: unknown,
): Record<string, unknown> {
  if (toolName !== 'slack_post_message' && toolName !== 'post_message') return args
  if (args.metadata !== undefined) return args
  const chainDepth = isRecord(trigger) ? trigger.chainDepth : undefined
  if (typeof chainDepth !== 'number' || !Number.isFinite(chainDepth)) return args
  return {
    ...args,
    metadata: { event_type: 'flow_message', event_payload: { chainDepth } },
  }
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
