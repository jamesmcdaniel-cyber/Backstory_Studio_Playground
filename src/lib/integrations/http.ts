/**
 * HTTP API integration — a built-in agent tool for calling external REST/JSON
 * APIs mid-run (query endpoints, enrich records, hit internal services).
 *
 * Safety: assertPublicUrl blocks private/internal targets (SSRF), redirects are
 * refused (they could bypass the check), one attempt is capped at 30s, and the
 * response body is truncated so a huge payload can't blow the context window.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { readResponseTextLimited } from '@/lib/net/response-body'

const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 50_000

export function httpTools(): ToolDefinition[] {
  return [
    {
      name: 'request',
      description:
        'Make an HTTP request to an external API and return the response. Use for querying REST/JSON APIs (GET) or sending data to them (POST/PUT/PATCH/DELETE). Public hosts only. Pass auth via the headers object when the user has supplied credentials in your instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET).' },
          url: { type: 'string', description: 'Absolute https URL to call.' },
          headers: { type: 'object', description: 'Optional request headers, e.g. {"authorization": "Bearer …"}.' },
          body: { type: 'string', description: 'Optional request body (typically JSON). Ignored for GET.' },
        },
        required: ['url'],
      },
    },
  ]
}

export class HttpToolClient {
  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'request') throw new Error(`Unknown HTTP tool: ${name}`)
    const url = String(args.url || '')
    await assertPublicUrl(url)

    const method = String(args.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' }
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
      for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }
    }
    const body = typeof args.body === 'string' && method !== 'GET' ? args.body : undefined
    if (body && !headers['content-type']) headers['content-type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' })
      const text = (await readResponseTextLimited(response, 250_000, 'HTTP tool response')).slice(0, MAX_RESPONSE_CHARS)
      return { status: response.status, ok: response.ok, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}
