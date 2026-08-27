/**
 * POST /api/v1/token — OAuth 2.0 client-credentials grant for the public API.
 *
 * Callers exchange their client id + secret for an access token that expires in
 * minutes, instead of sending a permanent key on every request. The persistent
 * credential then appears in exactly one request per 15 minutes rather than all
 * of them, which is the difference between a leaked proxy log exposing
 * something already dead and one exposing a live key.
 *
 * Deliberately RFC 6749 §4.4 shaped — `grant_type`, `client_id`,
 * `client_secret`, `scope`, and the standard error codes — so existing OAuth
 * client libraries work against it without special-casing.
 */

import { rateLimit } from '@/lib/ratelimit'
import { clientIp, recordTokenRejection, requestPath, recordSecurityEvent } from '@/lib/security/events'
import { exchangeClientCredentials, type ExchangeFailure } from '@/lib/public-api/client-credentials'
import { readRequestTextLimited, RequestBodyError } from '@/lib/server/request-body'

export const runtime = 'nodejs'
const TOKEN_REQUEST_MAX_BODY_BYTES = 32_000

function tokenError(error: string, description: string, status: number): Response {
  return Response.json(
    { error, error_description: description },
    // no-store is required by the spec and matters here: an intermediary that
    // caches a token response hands it to the next caller.
    { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  )
}

/**
 * Every credential failure answers `invalid_client`, whatever actually went
 * wrong. Distinguishing "no such client" from "wrong secret" turns this
 * endpoint into an oracle for enumerating valid client ids.
 */
const FAILURE_RESPONSE: Record<ExchangeFailure, { error: string; description: string; status: number }> = {
  invalid_client: { error: 'invalid_client', description: 'Client authentication failed.', status: 401 },
  unauthorized_client: { error: 'invalid_client', description: 'Client authentication failed.', status: 401 },
  invalid_grant: { error: 'invalid_grant', description: 'The client credentials have expired.', status: 400 },
  invalid_scope: {
    error: 'invalid_scope',
    description: 'The requested scope exceeds what this client is granted.',
    status: 400,
  },
}

export async function POST(request: Request): Promise<Response> {
  // Keyed on IP and failing closed: this endpoint takes a secret and says
  // whether it was right, which is precisely the shape worth brute-forcing.
  const limited = await rateLimit(`api-token:${clientIp(request) ?? 'unknown'}`, {
    limit: 30,
    windowMs: 60_000,
    failureMode: 'closed',
  })
  if (!limited.ok) {
    await recordSecurityEvent({
      kind: 'abuse.rate_limited',
      path: requestPath(request),
      method: request.method,
      ip: clientIp(request),
      detail: { surface: 'public-api-token' },
    })
    return tokenError('invalid_request', 'Too many token requests.', 429)
  }

  let credentials: Awaited<ReturnType<typeof readCredentials>>
  try {
    credentials = await readCredentials(request)
  } catch (error) {
    if (error instanceof RequestBodyError) return tokenError('invalid_request', error.message, error.status)
    throw error
  }
  const { clientId, clientSecret, grantType, scope } = credentials

  if (grantType !== 'client_credentials') {
    return tokenError('unsupported_grant_type', 'Only client_credentials is supported.', 400)
  }
  if (!clientId || !clientSecret) {
    await recordTokenRejection(request, { surface: 'public-api-token', reason: 'malformed_authorization' })
    return tokenError('invalid_request', 'client_id and client_secret are required.', 400)
  }

  const exchange = await exchangeClientCredentials({
    clientId,
    clientSecret,
    requestedScopes: scope ? scope.split(/\s+/).filter(Boolean) : undefined,
  })

  if (!exchange.ok) {
    await recordTokenRejection(request, { surface: 'public-api-token', reason: 'unknown_key' })
    const shape = FAILURE_RESPONSE[exchange.reason]
    return tokenError(shape.error, shape.description, shape.status)
  }

  return Response.json(
    {
      access_token: exchange.result.accessToken,
      token_type: 'Bearer',
      expires_in: exchange.result.expiresInSeconds,
      scope: exchange.result.scopes.join(' '),
    },
    { status: 200, headers: { 'cache-control': 'no-store', pragma: 'no-cache' } },
  )
}

/**
 * Accept the two forms clients actually send: HTTP Basic
 * (client_secret_basic) and form-encoded body (client_secret_post). Basic wins
 * when both are present, matching the spec's preference.
 */
async function readCredentials(request: Request): Promise<{
  clientId?: string
  clientSecret?: string
  grantType?: string
  scope?: string
}> {
  let body: URLSearchParams
  try {
    const contentType = request.headers.get('content-type') ?? ''
    const raw = await readRequestTextLimited(request, TOKEN_REQUEST_MAX_BODY_BYTES)
    body = contentType.includes('application/json')
      ? new URLSearchParams(Object.entries(JSON.parse(raw) as Record<string, string>))
      : new URLSearchParams(raw)
  } catch (error) {
    if (error instanceof RequestBodyError) throw error
    body = new URLSearchParams()
  }

  const result = {
    clientId: body.get('client_id') ?? undefined,
    clientSecret: body.get('client_secret') ?? undefined,
    grantType: body.get('grant_type') ?? undefined,
    scope: body.get('scope') ?? undefined,
  }

  const basic = /^Basic\s+(.+)$/i.exec(request.headers.get('authorization') ?? '')
  if (basic) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8')
      // Split on the FIRST colon only — a secret may legitimately contain one.
      const separator = decoded.indexOf(':')
      if (separator > 0) {
        result.clientId = decoded.slice(0, separator)
        result.clientSecret = decoded.slice(separator + 1)
      }
    } catch {
      /* fall through to the body values */
    }
  }

  return result
}
