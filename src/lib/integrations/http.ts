/**
 * HTTP API integration — a built-in agent tool for calling external REST/JSON
 * APIs mid-run (query endpoints, enrich records, hit internal services).
 *
 * Auth: when the workspace has a saved HTTP credential for the request's host
 * (configured in agent setup, the same store the flow HTTP node uses), it is
 * decrypted and applied here. The model never sees the secret and never needs
 * it in the agent's instructions — it just calls the URL.
 *
 * Safety: assertPublicUrl blocks private/internal targets (SSRF), redirects are
 * refused (they could bypass the check), one attempt is capped at 30s, and the
 * response body is truncated so a huge payload can't blow the context window.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { readResponseTextLimited } from '@/lib/net/response-body'
import { applyHttpCredential, resolveHttpCredential } from '@/features/flows/http-auth'

const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 50_000

export function httpTools(): ToolDefinition[] {
  return [
    {
      name: 'request',
      description:
        'Make an HTTP request to an external API and return the response. Use for querying REST/JSON APIs (GET) or sending data to them (POST/PUT/PATCH/DELETE). Public hosts only. Saved workspace credentials for the host are attached automatically — do not put API keys, tokens, or passwords in the headers yourself unless the user supplied one for this specific call.',
      inputSchema: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method (default GET).' },
          url: { type: 'string', description: 'Absolute https URL to call.' },
          headers: { type: 'object', description: 'Optional request headers. Omit auth headers when the workspace has a saved credential for this host.' },
          body: { type: 'string', description: 'Optional request body (typically JSON). Ignored for GET.' },
        },
        required: ['url'],
      },
    },
  ]
}

export class HttpToolClient {
  /**
   * Org scope for credential lookup. Omitted by callers with no org context
   * (the credential store is org-owned), in which case requests go out
   * unauthenticated exactly as before.
   */
  constructor(private readonly organizationId?: string) {}

  /**
   * The saved credential bound to this host, or null. Host-locked by the store:
   * a credential for api.example.com can never be attached to another host, so
   * a model calling an arbitrary URL cannot exfiltrate a workspace secret.
   */
  private async credentialForHost(host: string) {
    if (!this.organizationId) return null
    try {
      const row = await prisma.httpCredential.findFirst({
        where: { organizationId: this.organizationId, allowedHost: host, status: { in: ['verified', 'error'] } },
        orderBy: [{ status: 'asc' }, { lastVerifiedAt: 'desc' }],
        select: { id: true },
      })
      if (!row) return null
      return await resolveHttpCredential(row.id, this.organizationId)
    } catch (error) {
      // A missing/undecryptable credential must not fail the call — the request
      // still goes out unauthenticated and the API's own 401 tells the model.
      apiLogger.warn('http tool: credential lookup failed, calling without auth', {
        organizationId: this.organizationId,
        host,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

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

    // Attach the workspace credential for this host, if any. applyHttpCredential
    // re-checks the host binding itself, so this can't be pointed elsewhere.
    let request: { url: string; init: RequestInit } = { url, init: { method, headers, body } }
    const credential = await this.credentialForHost(new URL(url).hostname.toLowerCase())
    if (credential) {
      try {
        request = await applyHttpCredential(request, credential)
      } catch (error) {
        throw new Error(
          `The saved credential for ${credential.allowedHost} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const response = await fetch(request.url, { ...request.init, signal: controller.signal, redirect: 'error' })
      const text = (await readResponseTextLimited(response, 250_000, 'HTTP tool response')).slice(0, MAX_RESPONSE_CHARS)
      return { status: response.status, ok: response.ok, body: text, authenticated: Boolean(credential) }
    } finally {
      clearTimeout(timer)
    }
  }
}
