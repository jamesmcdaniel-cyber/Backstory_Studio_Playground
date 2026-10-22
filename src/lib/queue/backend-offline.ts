/**
 * The "no worker is consuming this queue" refusal, as a value every layer can
 * name without importing the queue client: the API handler maps it to a 503,
 * routes compare against it, and the heartbeat gate (src/lib/queue/heartbeat.ts)
 * throws it. Import-free on purpose — api-handler sits under every route.
 */

export const EXECUTION_BACKEND_OFFLINE_MESSAGE =
  'Execution backend is offline — no worker has reported a heartbeat recently, so the run was not started. Check the worker fleet (fly logs) and /api/health.'

/** The API error code every run route answers a dead worker fleet with. */
export const EXECUTION_BACKEND_OFFLINE_CODE = 'EXECUTION_BACKEND_OFFLINE'

export class ExecutionBackendOfflineError extends Error {
  readonly code = EXECUTION_BACKEND_OFFLINE_CODE
  constructor() {
    super(EXECUTION_BACKEND_OFFLINE_MESSAGE)
    this.name = 'ExecutionBackendOfflineError'
  }
}

/** By message as well as class: a caller may have re-wrapped it as a plain Error. */
export function isExecutionBackendOffline(error: unknown): boolean {
  return error instanceof ExecutionBackendOfflineError || (error instanceof Error && error.message === EXECUTION_BACKEND_OFFLINE_MESSAGE)
}
