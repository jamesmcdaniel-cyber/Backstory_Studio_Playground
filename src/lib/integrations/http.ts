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
import { applyHttpCredential, resolveHttpCredential, resolveHttpConnectionToken } from '@/features/flows/http-auth'
import {
  endpointToolDefinition,
  endpointToolName,
  fillEndpointTemplate,
  type AgentHttpEndpoint,
} from '@/lib/integrations/http-endpoints'

const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_CHARS = 50_000

export function httpTools(endpoints: AgentHttpEndpoint[] = []): ToolDefinition[] {
  return [
    // Each configured endpoint is its own named tool — the model calls
    // "get_weather(city)" with typed args instead of composing raw requests.
    ...endpoints.map((endpoint) => endpointToolDefinition(endpoint)),
    {
      name: 'request',
      description:
        'Make an HTTP request to an external API and return the response. Use for querying REST/JSON APIs (GET) or sending data to them (POST/PUT/PATCH/DELETE). Public hosts only. Saved workspace credentials for the host are attached automatically — do not put API keys, tokens, or passwords in the headers yourself unless the user supplied one for this specific call. Prefer this agent’s configured endpoint tools when one matches the task.',
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
   * unauthenticated exactly as before. `endpoints` are the agent's configured
   * API endpoints (each one a named tool); `userId` widens connection lookup
   * to the acting user's personal connections for endpoint auth.
   */
  constructor(
    private readonly organizationId?: string,
    private readonly endpoints: AgentHttpEndpoint[] = [],
    private readonly userId?: string,
  ) {}

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
      return await resolveHttpCredential(row.id, this.organizationId, {
        actorUserId: this.userId ?? null,
        consumer: 'agent.http_tool_host_match',
      })
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
    const endpoint = this.endpoints.find((entry) => endpointToolName(entry) === name)
    if (endpoint) return this.executeEndpoint(endpoint, args)
    if (name !== 'request') throw new Error(`Unknown HTTP tool: ${name}`)
    const url = String(args.url || '')
    const method = String(args.method || 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
      for (const [key, value] of Object.entries(args.headers as Record<string, unknown>)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }
    }
    const body = typeof args.body === 'string' && method !== 'GET' ? args.body : undefined
    return this.performRequest({ url, method, headers, body })
  }

  /**
   * A configured endpoint call: substitute the model's {{param}} args (encoded
   * where they land in the URL/query), then attach the endpoint's own auth —
   * its bound credential, its bound connection token, or the host-matched
   * workspace credential fallback.
   */
  private async executeEndpoint(endpoint: AgentHttpEndpoint, args: Record<string, unknown>): Promise<unknown> {
    const base = fillEndpointTemplate(endpoint.url, args, { encode: true })
    const url = new URL(base)
    for (const [key, value] of Object.entries(endpoint.query ?? {})) {
      url.searchParams.set(key, fillEndpointTemplate(value, args))
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(endpoint.headers ?? {})) {
      headers[key.toLowerCase()] = fillEndpointTemplate(value, args)
    }
    const body =
      endpoint.bodyMode === 'json' && endpoint.body && endpoint.method !== 'GET' && endpoint.method !== 'HEAD'
        ? fillEndpointTemplate(endpoint.body, args)
        : undefined

    let boundCredential: Awaited<ReturnType<typeof resolveHttpCredential>> | null = null
    let bearerToken: string | undefined
    if (endpoint.credentialId && this.organizationId) {
      boundCredential = await resolveHttpCredential(endpoint.credentialId, this.organizationId, {
        actorUserId: this.userId ?? null,
        consumer: 'agent.http_endpoint',
      })
    } else if (endpoint.connectionId && this.organizationId) {
      bearerToken = await resolveHttpConnectionToken({
        connectionId: endpoint.connectionId,
        organizationId: this.organizationId,
        userId: this.userId,
      })
    }
    return this.performRequest({ url: url.toString(), method: endpoint.method, headers, body, boundCredential, bearerToken })
  }

  private async performRequest(params: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
    boundCredential?: Awaited<ReturnType<typeof resolveHttpCredential>> | null
    bearerToken?: string
  }): Promise<unknown> {
    const { url, method, body } = params
    await assertPublicUrl(url)
    const headers: Record<string, string> = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...params.headers }
    if (body && !headers['content-type']) headers['content-type'] = 'application/json'

    // Attach auth: an endpoint-bound credential, a connection's fresh token, or
    // the workspace credential for this host. applyHttpCredential re-checks the
    // host binding itself, so a credential can't be pointed elsewhere.
    let request: { url: string; init: RequestInit } = { url, init: { method, headers, body } }
    const credential = params.boundCredential ?? (params.bearerToken ? null : await this.credentialForHost(new URL(url).hostname.toLowerCase()))
    if (credential) {
      try {
        request = await applyHttpCredential(request, credential)
      } catch (error) {
        throw new Error(
          `The saved credential for ${credential.allowedHost} could not be applied: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } else if (params.bearerToken) {
      request.init.headers = { ...headers, authorization: `Bearer ${params.bearerToken}` }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    try {
      const response = await fetch(request.url, { ...request.init, signal: controller.signal, redirect: 'error' })
      const text = (await readResponseTextLimited(response, 250_000, 'HTTP tool response')).slice(0, MAX_RESPONSE_CHARS)
      return { status: response.status, ok: response.ok, body: text, authenticated: Boolean(credential || params.bearerToken) }
    } finally {
      clearTimeout(timer)
    }
  }
}
