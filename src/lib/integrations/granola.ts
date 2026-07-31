/**
 * Granola REST API integration
 *
 * Exposes two agent tools — list_notes and get_note — that let agents
 * read the user's Granola meeting notes during a run.
 *
 * Key resolution (per organization):
 *  1. The org's saved key from integration_secrets (provider 'granola'),
 *     stored encrypted via the shared secrets helpers.
 *  2. GRANOLA_API_KEY from the environment — reachable ONLY by internal/partner
 *     workspaces (see org-credential.ts). It is one Granola account: letting
 *     every customer org read it is the same cross-tenant path that Slack and
 *     Email had.
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { resolveOrgCredential, type CredentialSource } from './org-credential'

export const GRANOLA_BASE_URL = 'https://public-api.granola.ai/v1'

// ---------------------------------------------------------------------------
// Per-org key resolution
// ---------------------------------------------------------------------------

export type GranolaKeySource = CredentialSource

export type ResolvedGranolaKey = { apiKey: string; source: GranolaKeySource }

/**
 * Resolves the Granola API key for an organization: the org's saved key
 * first, then the GRANOLA_API_KEY env fallback. Returns null when neither
 * is available.
 */
export async function getGranolaApiKey(organizationId: string): Promise<ResolvedGranolaKey | null> {
  const resolved = await resolveOrgCredential({
    organizationId,
    provider: 'granola',
    envValue: process.env.GRANOLA_API_KEY,
  })
  return resolved ? { apiKey: resolved.value, source: resolved.source } : null
}

export async function granolaConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await getGranolaApiKey(organizationId))
}

/**
 * Lightweight connection test: lists notes with the given key. Returns the
 * upstream status so callers can distinguish a bad key (401/403) from an
 * outage.
 */
export async function testGranolaApiKey(
  apiKey: string,
): Promise<{ ok: boolean; status: number | null }> {
  try {
    const response = await fetch(`${GRANOLA_BASE_URL}/notes`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    return { ok: response.ok, status: response.status }
  } catch {
    return { ok: false, status: null }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function granolaTools(): ToolDefinition[] {
  return [
    {
      name: 'list_notes',
      description:
        "List the user's recent Granola meeting notes (id, title, owner, AI summary). Optionally filter with created_after (ISO 8601 date) and paginate with cursor.",
      inputSchema: {
        type: 'object',
        properties: {
          created_after: { type: 'string' },
          cursor: { type: 'string' },
        },
      },
    },
    {
      name: 'get_note',
      description: "Get a Granola meeting note's full AI summary and transcript by id.",
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'Granola note id (not_...)' },
        },
        required: ['note_id'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// GranolaToolClient
// ---------------------------------------------------------------------------

export class GranolaToolClient {
  // The resolved per-org key is injected at construction time (see
  // getGranolaApiKey) so tool execution never reads global state.
  constructor(private readonly apiKey: string) {}

  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // BackstoryMcpClient.executeTool (response.result), so the run loop's
  // JSON.stringify(result) wrapping is identical for both integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.apiKey) throw new Error('Granola API key is not configured')

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }

    let url: string

    if (name === 'list_notes') {
      const params = new URLSearchParams()
      if (typeof args.created_after === 'string' && args.created_after) {
        params.set('created_after', args.created_after)
      }
      if (typeof args.cursor === 'string' && args.cursor) {
        params.set('cursor', args.cursor)
      }
      const qs = params.toString()
      url = qs ? `${GRANOLA_BASE_URL}/notes?${qs}` : `${GRANOLA_BASE_URL}/notes`
    } else if (name === 'get_note') {
      const noteId = String(args.note_id ?? '')
      url = `${GRANOLA_BASE_URL}/notes/${encodeURIComponent(noteId)}?include=transcript`
    } else {
      throw new Error(`Unknown Granola tool: ${name}`)
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      throw new Error(`Granola API error ${response.status}`)
    }

    return response.json() as Promise<unknown>
  }
}
