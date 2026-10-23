/**
 * Shared admission for the external-agent public API
 * (/api/v1/agents/executions/[id]/…): the per-caller rate limit, the reply
 * token's two carriers, and the one 404 every capability failure answers with.
 */

import { publicApiJson } from '@/lib/public-api/auth'
import { rateLimit } from '@/lib/ratelimit'
import { EXTERNAL_REPLY_TOKEN_HEADER } from './types'

/** The single answer for unknown execution, other agent's execution, wrong, reused or expired token. */
export function externalNotFound(): Response {
  return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404)
}

export function clientIpOf(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/**
 * Per-IP ceiling, checked BEFORE the key is looked up so a flood of guesses
 * never reaches the database. Fails closed: an ingress must not lose its
 * ceiling when Redis is unavailable.
 */
export async function externalIngressLimited(request: Request, surface: string, limit: number): Promise<Response | null> {
  const limited = await rateLimit(`external-agent-${surface}:${clientIpOf(request)}`, { limit, windowMs: 60_000, failureMode: 'closed' })
  if (limited.ok) return null
  return publicApiJson({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded.' } }, 429)
}

/** The token from the JSON body, or the header for callers that prefer it there. */
export function presentedReplyToken(request: Request, body: { replyToken?: string } | null): string {
  return (body?.replyToken || request.headers.get(EXTERNAL_REPLY_TOKEN_HEADER) || '').trim()
}

/** Execution id from /api/v1/agents/executions/[id]/<leaf>. */
export function executionIdFromPath(request: Request, leaf: boolean): string {
  const parts = new URL(request.url).pathname.split('/')
  return decodeURIComponent((leaf ? parts.at(-2) : parts.at(-1)) ?? '')
}

/** Only web links survive into a reply — a `javascript:` URL is a valid URL too. */
export function safeLinks(links: Array<{ title?: string; url: string }>): Array<{ title: string; url: string }> {
  return links
    .filter((link) => {
      try {
        const protocol = new URL(link.url).protocol
        return protocol === 'https:' || protocol === 'http:'
      } catch {
        return false
      }
    })
    .map((link) => ({ title: (link.title || link.url).slice(0, 200), url: link.url }))
}
