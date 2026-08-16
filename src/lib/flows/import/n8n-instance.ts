/**
 * Importing a workflow straight from a personal n8n instance.
 *
 * An n8n editor URL (`https://<instance>/workflow/<id>`) serves the
 * login-walled editor app — the workflow JSON behind it lives at
 * `/api/v1/workflows/<id>` and answers 401 without an `X-N8N-API-KEY`. So
 * "paste the URL and it just works" requires a stored key for that instance.
 *
 * The key is a plain HTTP credential (authType `header`), which is the point:
 * it inherits the entire credential treatment already built — encryption at
 * rest, per-user ownership, host binding, grant/use audit, rotation and
 * staleness tracking, revocation on offboarding — instead of growing a
 * parallel storage path that would need each of those re-implemented.
 *
 * This module is the pure part: recognizing the URL shape and deriving the
 * API endpoint. The route owns credential lookup and the fetch.
 */

/** The header n8n's public API authenticates with. */
export const N8N_API_KEY_HEADER = 'X-N8N-API-KEY'

export interface N8nInstanceRef {
  /** Lowercased hostname, the credential-lookup key. */
  host: string
  workflowId: string
  /** The JSON endpoint for the workflow. */
  apiUrl: string
}

/**
 * Recognize a personal-instance editor URL and derive its API endpoint.
 *
 * Returns null for anything else — including the n8n.io gallery, whose
 * `/workflows/` (plural) path is a different, public thing handled by
 * resolveN8nImportUrl. The workflow id charset is n8n's nanoid alphabet;
 * anything outside it is not an editor URL and must not produce a fetch.
 */
export function parseN8nInstanceUrl(raw: string): N8nInstanceRef | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname === 'n8n.io' || url.hostname === 'www.n8n.io') return null

  const match = url.pathname.match(/^\/workflow\/([A-Za-z0-9_-]{8,64})\/?$/)
  if (!match) return null

  const host = url.hostname.toLowerCase()
  return {
    host,
    workflowId: match[1],
    // Rebuilt from parsed parts, never by string surgery on the input — a
    // crafted path cannot smuggle extra segments into the API URL.
    apiUrl: `https://${host}/api/v1/workflows/${match[1]}`,
  }
}
