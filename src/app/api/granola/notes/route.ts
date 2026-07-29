import { getGranolaApiKey, GRANOLA_BASE_URL } from '@/lib/integrations/granola'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export type GranolaNoteSummary = {
  id: string
  title: string
  owner: { name: string; email: string } | null
  created_at: string | null
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const resolved = await getGranolaApiKey(auth.organizationId)
  if (!resolved) {
    return { success: false, error: 'Granola is not connected', notes: [] }
  }

  let raw: unknown
  try {
    const response = await fetch(`${GRANOLA_BASE_URL}/notes`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${resolved.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      return {
        success: false,
        error: `Granola returned an error (status ${response.status}). Check your API key.`,
        notes: [],
      }
    }
    raw = await response.json()
  } catch {
    return { success: false, error: 'Could not reach Granola. Please try again.', notes: [] }
  }

  // The list may nest notes under a `notes` or `data` key, or be an array itself.
  let items: unknown[]
  if (Array.isArray(raw)) {
    items = raw
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.notes)) {
      items = obj.notes
    } else if (Array.isArray(obj.data)) {
      items = obj.data
    } else {
      items = []
    }
  } else {
    items = []
  }

  const notes: GranolaNoteSummary[] = items
    .slice(0, 25)
    .map((item) => {
      const n = item as Record<string, unknown>
      const owner = n.owner && typeof n.owner === 'object'
        ? (n.owner as Record<string, unknown>)
        : null
      return {
        id: String(n.id ?? ''),
        title: String(n.title ?? 'Untitled'),
        owner: owner
          ? { name: String(owner.name ?? ''), email: String(owner.email ?? '') }
          : null,
        created_at: n.created_at ? String(n.created_at) : null,
      }
    })
    .filter((n) => n.id)

  return { success: true, notes }
}, { permission: 'agent.read' })
