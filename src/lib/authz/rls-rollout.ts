import { ORG_SCOPED_MODELS } from '@/lib/tenant-guard'

/**
 * Which models route their queries through the PostgreSQL RLS path.
 *
 * ── Why this is not a boolean ────────────────────────────────────────────
 * RLS is fully built — policies, a non-owner app role, `SET LOCAL
 * app.organization_id`, and the transaction wrapper in src/lib/prisma.ts — and
 * it is switched off in production. It was enabled once as a single batch and
 * caused three outages, because turning it on for every org-scoped model at once
 * moves EVERY query onto the transaction path simultaneously: each one takes a
 * pooled connection for the length of the statement, and against a pgbouncer
 * transaction pooler with connection_limit=1 that is a different concurrency
 * profile than the one the app was load-tested under.
 *
 * A boolean offers no way to find that out except by repeating it. This resolves
 * a SET of models instead, so the rollout can move a few tables at a time, with
 * connection metrics watched between steps, and roll back one table rather than
 * all of them.
 *
 * ── DATABASE_RLS_ENABLED ─────────────────────────────────────────────────
 *   unset / 'false'  — off. The app-layer tenant guard is the only boundary.
 *   'true'           — every org-scoped model. The batch that caused the
 *                      outages; correct as a final state, not as a first step.
 *   'Model,Model2'   — exactly these models. The staged path.
 *
 * Names are Prisma model names as they appear in ORG_SCOPED_MODELS (e.g.
 * `FlowRun`, not `flow_runs`). An unknown name is a configuration error and
 * throws at boot rather than silently protecting nothing — a typo'd table that
 * quietly stays unprotected is the failure this whole mechanism exists to avoid.
 */
export function rlsEnabledModels(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.DATABASE_RLS_ENABLED?.trim()
  if (!raw || raw === 'false') return EMPTY
  if (raw === 'true') return ORG_SCOPED_MODELS

  const requested = raw.split(',').map((name) => name.trim()).filter(Boolean)
  const unknown = requested.filter((name) => !ORG_SCOPED_MODELS.has(name))
  if (unknown.length) {
    throw new Error(
      `DATABASE_RLS_ENABLED names unknown model(s): ${unknown.join(', ')}. ` +
        'Use Prisma model names from ORG_SCOPED_MODELS (src/lib/tenant-guard.ts), ' +
        "or 'true' for all of them.",
    )
  }
  return new Set(requested)
}

const EMPTY: ReadonlySet<string> = new Set()

/**
 * Cached per process. Reading the environment on every query would put a string
 * split on the hot path of every database call in the app.
 */
let cached: ReadonlySet<string> | null = null

export function rlsModels(): ReadonlySet<string> {
  if (cached === null) cached = rlsEnabledModels()
  return cached
}

/** Whether this model's queries must run through the RLS transaction path. */
export function rlsAppliesTo(model: string | undefined): boolean {
  if (!model) return false
  const models = rlsModels()
  return models.size > 0 && models.has(model)
}

/**
 * Whether ANY model is on the RLS path — i.e. whether the app should connect as
 * the non-owner role and set tenant context at all.
 */
export function rlsActive(): boolean {
  return rlsModels().size > 0
}

/** Test-only: drop the cache after mutating the environment. */
export function resetRlsRolloutCache(): void {
  cached = null
}
