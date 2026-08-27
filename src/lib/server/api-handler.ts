import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { AuthContextError, PermissionDeniedError, requireAuthContext, type AuthContext } from './auth'
import type { Permission } from '@/lib/authz/permissions'
import { rateLimit, type RateLimitOptions } from '@/lib/ratelimit'
import { isCustomerEdition } from '@/lib/edition'
import { clientIp, recordSecurityEvent } from '@/lib/security/events'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { recordPresence } from '@/lib/server/presence'
import { CircuitOpenError } from '@/lib/resilience/circuit-breaker'
import { boundedNextRequest, RequestBodyError, requestBodyErrorResponse } from '@/lib/server/request-body'

/**
 * Default write budget, per user per minute, applied to every mutating request.
 *
 * Rate limiting used to be opt-in and reached 9 of 107 routes — so a script (or
 * a runaway client loop) could hammer any of the other ~98 without meeting a
 * ceiling. Enforcing it in the wrapper means new routes are covered the day they
 * are written, rather than whenever someone remembers.
 *
 * Reads are deliberately NOT limited here: the app shell polls by design, and a
 * budget tight enough to matter for writes would break it. GET pressure is a
 * capacity problem, addressed by the snapshot consolidation and the poll intervals.
 *
 * 240/min is far above any legitimate client — the busiest writer in the product
 * is the flow editor's autosave, debounced to one PUT per 2s (≤30/min). It is a
 * backstop against abuse and loops, not a quota.
 *
 * NOTE: this is only a GLOBAL limit when a shared backend is configured
 * (UPSTASH_REDIS_REST_* or REDIS_URL). Otherwise src/lib/ratelimit.ts falls back
 * to per-instance memory and the effective ceiling multiplies by instance count.
 */
const DEFAULT_WRITE_RATE_LIMIT: RateLimitOptions = {
  limit: Math.max(1, Number(process.env.WRITE_RATE_LIMIT_PER_MIN) || 240),
  windowMs: 60_000,
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Default request-body ceiling for a mutating route, in bytes.
 *
 * Most routes parse their body through a zod schema whose field bounds cap the
 * size implicitly. A handful legitimately accept free-form JSON — a signal
 * payload, a resume payload, an agent trigger input — where there is no schema
 * to bound and the body becomes whatever the caller sends. Rejecting on the
 * declared length costs nothing and puts a ceiling under every route rather than
 * only the ones someone remembered.
 *
 * Deliberately NOT as tight as FLOW_WEBHOOK_MAX_BODY_BYTES (1 MB). The webhook
 * path enforces its own limit in-route, whereas this ceiling sits under the flow
 * autosave PUT, which serialises the entire graph — pinned node data included —
 * on every save. A 1 MB wrapper default would reject legitimate saves of a large
 * flow. 4 MB is far above any real graph and still bounds an abusive body.
 */
const DEFAULT_MAX_BODY_BYTES = Math.max(
  1024,
  Number(process.env.API_MAX_BODY_BYTES) || 4_000_000,
)

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'BAD_REQUEST',
    // The underlying error (when this ApiError wraps a caught failure), so 5xx
    // handling can log/report the real cause instead of the generic message.
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type AuthenticatedHandler = (
  request: NextRequest,
  auth: AuthContext,
  // Next's dynamic-segment context ({ params }), forwarded untouched so
  // [id] routes can read their params through the same wrapper.
  context?: unknown,
) => Promise<Response | Record<string, unknown>>

export function withAuthenticatedApi(
  handler: AuthenticatedHandler,
  // `permission: null` means "any authenticated caller, deliberately" — the
  // auth context itself, invite acceptance, notifications. It is spelled out
  // rather than omitted so the coverage test can tell a considered decision
  // from a forgotten one.
  options?: {
    skipBackstoryGate?: boolean
    skipEntitlementGate?: boolean
    skipMfaGate?: boolean
    skipSsoGate?: boolean
    permission?: Permission | null
    /**
     * Override the default per-user write budget, or pass `false` to opt out
     * (for a route that already applies its own, tighter, limit).
     */
    writeRateLimit?: RateLimitOptions | false
    /**
     * Internal-edition surface. In the customer edition the route answers 404
     * as though it did not exist — checked BEFORE auth, so a customer tenant is
     * never told that an internal route is there to be authenticated against.
     */
    internalOnly?: boolean
    /**
     * Override the default request-body ceiling, or pass `false` to opt out
     * (file uploads, which enforce their own quota-aware limit).
     */
    maxBodyBytes?: number | false
  },
) {
  return async (request: NextRequest, context?: unknown): Promise<Response> => {
    // Held outside the try so the catch can attribute a 403 to the account that
    // earned it. A 401 never reaches this — there is no identity to record.
    let authContext: AuthContext | null = null
    let handlerRequest = request
    const where = { path: request.nextUrl.pathname, method: request.method, ip: clientIp(request) }

    try {
      if (options?.internalOnly && isCustomerEdition()) {
        return NextResponse.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
      }

      // Before auth: read through an actual byte ceiling, then rebuild the
      // request for the handler. Content-Length alone is only a hint: chunked,
      // omitted, and falsified lengths must meet the same application limit.
      const bodyLimit = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
      if (bodyLimit !== false && !READ_METHODS.has(request.method)) {
        try {
          handlerRequest = await boundedNextRequest(request, bodyLimit)
        } catch (error) {
          if (!(error instanceof RequestBodyError)) throw error
          if (error.code === 'BODY_TOO_LARGE') {
            await recordSecurityEvent({
              ...where,
              kind: 'abuse.body_too_large',
              detail: { code: error.code, limitBytes: bodyLimit },
            })
          }
          return requestBodyErrorResponse(error)
        }
      }

      const auth = await requireAuthContext(options)
      authContext = auth
      // Presence, recorded once per user per window and never awaited. Placed
      // before the permission gate deliberately: a 403 still proves the account
      // was here, and "last seen" that silently skipped denied requests would
      // under-report exactly the accounts an admin most wants to look at.
      recordPresence(auth.userId)
      // The gate runs BEFORE the handler, so a rejected call has no side effects.
      if (options?.permission && !auth.can(options.permission)) {
        throw new PermissionDeniedError(options.permission)
      }

      // Same ordering rationale as the permission gate: reject before the
      // handler runs, so a throttled call leaves nothing behind.
      const writeLimit = options?.writeRateLimit ?? DEFAULT_WRITE_RATE_LIMIT
      if (writeLimit !== false && !READ_METHODS.has(request.method)) {
        const limited = await rateLimit(`write:${auth.userId}`, writeLimit)
        if (!limited.ok) {
          await recordSecurityEvent({
            ...where,
            kind: 'abuse.rate_limited',
            userId: auth.userId,
            organizationId: auth.organizationId,
            detail: { gate: 'write-budget', limit: writeLimit.limit, windowMs: writeLimit.windowMs },
          })
          return NextResponse.json(
            { success: false, error: 'Too many requests — please slow down.', code: 'RATE_LIMITED' },
            {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 1000) / 1000)) },
            },
          )
        }
      }

      // Establish the caller's tenant for the whole handler. Parent-scoped
      // models (FlowRunStep, WorkflowStep, ExecutionMessage, WorkflowEvent,
      // FlowCollaborator) resolve tenancy through a parent row, so under RLS
      // they need `app.organization_id` set for a query that has no
      // organizationId of its own to route on. The guard in src/lib/prisma.ts
      // reads this and opens a correctly-scoped transaction for exactly those
      // queries. A hint about WHICH tenant, not a grant: the permission gate
      // above already decided the caller may be here, and PostgreSQL's policy
      // is still what enforces.
      const result = await ambientOrganization.run(auth.organizationId, () =>
        handler(handlerRequest, auth, context),
      )

      return result instanceof Response ? result : NextResponse.json(result)
    } catch (error) {
      if (error instanceof AuthContextError) {
        // 401 is anonymous by definition; 403 always has an identity behind it,
        // which is what makes a permission sweep attributable to an account
        // rather than smeared across the IPs it dialled from.
        await recordSecurityEvent({
          ...where,
          kind: error.status === 403 ? 'auth.forbidden' : 'auth.failed',
          userId: authContext?.userId ?? null,
          organizationId: authContext?.organizationId ?? null,
          detail: {
            code: error.code,
            ...(error instanceof PermissionDeniedError && { required: error.required }),
          },
        })
        return NextResponse.json(
          {
            success: false,
            error: error.message,
            code: error.code,
            // Name the missing permission so a 403 is debuggable without
            // guessing which gate rejected the call.
            ...(error instanceof PermissionDeniedError && { detail: { required: error.required } }),
          },
          { status: error.status },
        )
      }

      if (error instanceof ApiError) {
        // Server-side ApiErrors (5xx) are real failures — log + report them.
        // Client errors (4xx) are expected and returned quietly.
        if (error.status >= 500) {
          apiLogger.error('API request failed (ApiError)', {
            path: request.nextUrl.pathname,
            code: error.code,
            status: error.status,
            error: error.message,
            cause: error.cause instanceof Error ? error.cause.message : error.cause ? String(error.cause) : undefined,
          })
          captureError(error.cause ?? error, { path: request.nextUrl.pathname, code: error.code })
        }
        // The AI guard and the per-route limiters throw 429 rather than
        // returning it, so this is where interactive LLM abuse becomes visible.
        if (error.status === 429) {
          await recordSecurityEvent({
            ...where,
            kind: 'abuse.rate_limited',
            userId: authContext?.userId ?? null,
            organizationId: authContext?.organizationId ?? null,
            detail: { gate: error.code },
          })
        }
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
        )
      }

      // An open circuit is backpressure, not a bug: a dependency this request
      // needs has failed repeatedly and is being given room to recover. 503 with
      // Retry-After says exactly that, and says it in the vocabulary clients and
      // proxies already understand — a 500 would invite an immediate retry into
      // the dependency the breaker is protecting, and would page someone about
      // an application fault that is not one.
      //
      // Not recorded as a security event: nobody did anything abusive. The
      // breaker's own log line, emitted once when it opened rather than once per
      // refused request, is the operational signal.
      if (error instanceof CircuitOpenError) {
        return NextResponse.json(
          { success: false, error: error.message, code: error.code, detail: { dependency: error.dependency } },
          {
            status: 503,
            headers: { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) },
          },
        )
      }

      if (error instanceof ZodError) {
        return NextResponse.json(
          { success: false, error: 'Invalid request', code: 'VALIDATION_ERROR', issues: error.issues },
          { status: 400 },
        )
      }

      apiLogger.error('API request failed', {
        path: request.nextUrl.pathname,
        error: error instanceof Error ? error.message : String(error),
      })
      captureError(error, { path: request.nextUrl.pathname })

      return NextResponse.json(
        { success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      )
    }
  }
}
