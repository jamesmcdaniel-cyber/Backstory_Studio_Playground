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

/** Queues one worker process consumes concurrently (see runtime.ts workerSpecs). */
const WORKER_QUEUE_COUNT = 4

const FATAL_VARS = [
  ['REDIS_URL', 'the queue plane — the worker cannot consume anything'],
  ['DATABASE_URL', 'Postgres — runs cannot be read or written'],
  ['ENCRYPTION_KEY', 'secret decryption — every stored credential is unreadable'],
  ['ANTHROPIC_API_KEY', 'model calls — every agent/flow step fails'],
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

/** Pure audit over an env map — `concurrency` is per-queue (workerConfig). */
export function auditWorkerEnv(env: Record<string, string | undefined>, concurrency: number): WorkerEnvAudit {
  const fatal = FATAL_VARS.filter(([name]) => !env[name]).map(
    ([name, consequence]) => `${name} is missing — ${consequence}.`,
  )
  const warnings = WARN_VARS.filter(([name]) => !env[name]).map(
    ([name, consequence]) => `${name} is missing — ${consequence}.`,
  )

  const limitMatch = env.DATABASE_URL?.match(/[?&]connection_limit=(\d+)/)
  if (limitMatch) {
    const limit = Number(limitMatch[1])
    const needed = WORKER_QUEUE_COUNT * concurrency
    if (limit < needed) {
      warnings.push(
        `DATABASE_URL has connection_limit=${limit} but this worker runs up to ${needed} concurrent jobs ` +
          `(${WORKER_QUEUE_COUNT} queues × concurrency ${concurrency}) on one Prisma pool — expect P2024 pool timeouts. ` +
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
  log: { warn: (msg: string) => void; error: (msg: string) => void },
): void {
  const audit = auditWorkerEnv(process.env, concurrency)
  for (const warning of audit.warnings) log.warn(`worker env: ${warning}`)
  for (const finding of audit.fatal) log.error(`worker env: ${finding}`)
  if (audit.fatal.length > 0) {
    throw new Error(`Worker env is unbootable: ${audit.fatal.join(' ')}`)
  }
}
