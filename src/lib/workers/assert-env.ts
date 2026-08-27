/**
 * Boot-time env audit for the queue-plane worker. The worker fleet runs far
 * from the Vercel app with its own secret set (fly secrets / render.yaml), so
 * a missing value doesn't fail a build — it fails a user's run hours later.
 * Fatal findings stop the boot (a worker without Redis/DB/crypto consumes jobs
 * only to crash them); warnings name the capability that silently degrades.
 */

export interface WorkerEnvAudit {
  fatal: string[]
  warnings: string[]
}

export type WorkerCapacitySpec = { queue: string; concurrency?: number }
export type WorkerCapacity = {
  queueCount: number
  jobSlots: number
  infrastructureReserve: number
  recommendedConnectionLimit: number
}

/** Outbox, schedule reconciliation, liveness, and terminal writes continue
 * while job slots are occupied. Keep two pool connections outside job demand. */
const INFRASTRUCTURE_CONNECTION_RESERVE = 2

export function workerCapacity(
  specs: readonly WorkerCapacitySpec[],
  defaultConcurrency: number,
): WorkerCapacity {
  const normalizedDefault = Math.max(1, Math.floor(defaultConcurrency))
  const jobSlots = specs.reduce(
    (sum, spec) => sum + Math.max(1, Math.floor(spec.concurrency ?? normalizedDefault)),
    0,
  )
  return {
    queueCount: specs.length,
    jobSlots,
    infrastructureReserve: INFRASTRUCTURE_CONNECTION_RESERVE,
    recommendedConnectionLimit: jobSlots + INFRASTRUCTURE_CONNECTION_RESERVE,
  }
}

const FATAL_VARS = [
  ['REDIS_URL', 'the queue plane — the worker cannot consume anything'],
  ['DATABASE_URL', 'Postgres — runs cannot be read or written'],
  ['ENCRYPTION_KEY', 'secret decryption — every stored credential is unreadable'],
] as const

const WARN_VARS = [
  ['SENTRY_DSN', 'worker crashes and dead-letters are console-only (invisible outside fly logs)'],
  ['NANGO_SECRET_KEY', 'integration tools in flows will fail'],
  ['VOYAGE_API_KEY', 'RAG embeddings are unavailable'],
  ['VAPID_PUBLIC_KEY', 'run-completion push notifications are dropped'],
  ['VAPID_PRIVATE_KEY', 'run-completion push notifications are dropped'],
  ['NEXT_PUBLIC_APP_URL', 'links in notifications/emails point nowhere'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'realtime run updates are silent — the builder falls back to slow polling'],
] as const

/** Pure audit over the exact queue specs this process is about to consume. */
export function auditWorkerEnv(
  env: Record<string, string | undefined>,
  concurrency: number,
  specs: readonly WorkerCapacitySpec[],
): WorkerEnvAudit {
  const fatal = FATAL_VARS.filter(([name]) => !env[name]).map(
    ([name, consequence]) => `${name} is missing — ${consequence}.`,
  )
  const warnings = WARN_VARS.filter(([name]) => !env[name]).map(
    ([name, consequence]) => `${name} is missing — ${consequence}.`,
  )
  const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY)
  const hasQwenKey = Boolean(env.QWEN_API_KEY)
  const hasQwenUrl = Boolean(env.QWEN_BASE_URL)
  if (!hasAnthropic && !(hasQwenKey && hasQwenUrl)) {
    fatal.push('No model provider is configured — set ANTHROPIC_API_KEY or both QWEN_API_KEY and QWEN_BASE_URL.')
  } else if (hasQwenKey !== hasQwenUrl) {
    warnings.push('Qwen configuration is incomplete — QWEN_API_KEY and QWEN_BASE_URL are both required, so Qwen fallback is disabled.')
  }
  if (specs.length === 0) {
    fatal.push(`WORKER_POOL=${env.WORKER_POOL || 'all'} consumes no queues in this edition.`)
  }

  const limitMatch = env.DATABASE_URL?.match(/[?&]connection_limit=(\d+)/)
  if (limitMatch) {
    const limit = Number(limitMatch[1])
    const capacity = workerCapacity(specs, concurrency)
    const needed = capacity.recommendedConnectionLimit
    if (limit < needed) {
      warnings.push(
        `DATABASE_URL has connection_limit=${limit} but this worker needs approximately ${needed} pool connections ` +
          `(${capacity.jobSlots} job slots across ${capacity.queueCount} queues + ${capacity.infrastructureReserve} infrastructure reserve) ` +
          `on one Prisma pool — expect P2024 pool timeouts. ` +
          `Use the worker's own URL with connection_limit=${needed} (NOT the serverless connection_limit=1 string).`,
      )
    }
  }

  return { fatal, warnings }
}

/**
 * Runtime entry: log every finding, throw when the env is unbootable.
 * Warnings are prefixed for easy grepping in fly logs.
 */
export function assertWorkerEnv(
  concurrency: number,
  specs: readonly WorkerCapacitySpec[],
  log: { warn: (msg: string) => void; error: (msg: string) => void },
): void {
  const audit = auditWorkerEnv(process.env, concurrency, specs)
  for (const warning of audit.warnings) log.warn(`worker env: ${warning}`)
  for (const finding of audit.fatal) log.error(`worker env: ${finding}`)
  if (audit.fatal.length > 0) {
    throw new Error(`Worker env is unbootable: ${audit.fatal.join(' ')}`)
  }
}
