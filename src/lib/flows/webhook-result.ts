export type WebhookRunState = {
  status: string
  output?: unknown
  error?: string | null
  finishedAt?: Date | null
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'stopped'])

export function isTerminalFlowRunStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

export async function waitForFlowRunResult<T extends WebhookRunState>(options: {
  load: () => Promise<T | null>
  timeoutMs: number
  pollMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<T | null> {
  const pollMs = Math.max(25, options.pollMs ?? 250)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + Math.max(0, options.timeoutMs)
  let latest: T | null = null

  do {
    if (options.signal?.aborted) return latest
    latest = await options.load()
    // A paused flow cannot produce a synchronous result until another actor
    // resumes it, so release the webhook immediately rather than polling until
    // the deadline. Every terminal outcome is likewise ready to return.
    if (!latest || latest.status === 'waiting' || isTerminalFlowRunStatus(latest.status)) return latest
    if (now() >= deadline) break
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  } while (now() <= deadline)

  return latest
}
