import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'
import { AuthContextError, PermissionDeniedError, requireAuthContext, type AuthContext } from './auth'
import type { Permission } from '@/lib/authz/permissions'
import { rateLimit, type RateLimitOptions } from '@/lib/ratelimit'
import { isCustomerEdition } from '@/lib/edition'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'
import { recordAudit } from '@/lib/audit'

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
  },
) {
  return async (request: NextRequest, context?: unknown): Promise<Response> => {
    try {
      if (options?.internalOnly && isCustomerEdition()) {
        return NextResponse.json({ success: false, error: 'Not found', code: 'NOT_FOUND' }, { status: 404 })
      }

      const auth = await requireAuthContext(options)
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
          return NextResponse.json(
            { success: false, error: 'Too many requests — please slow down.', code: 'RATE_LIMITED' },
            {
              status: 429,
              headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 1000) / 1000)) },
            },
          )
        }
      }

      const result = await handler(request, auth, context)

      if (!READ_METHODS.has(request.method) && isPlatformOwnerEmail(auth.dbUser.email)) {
        void recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.dbUser.id,
          action: 'platform_owner.api_write',
          resourceType: 'api_route',
          resourceId: request.nextUrl.pathname,
          detail: { method: request.method },
          ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null,
        })
      }

      return result instanceof Response ? result : NextResponse.json(result)
    } catch (error) {
      if (error instanceof AuthContextError) {
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
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status: error.status },
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
