/**
 * Demo transport: nothing leaves the system from a demo org.
 *
 * The demo org holds no credentials by construction, so outbound calls could
 * only ever fail — but a captured run must SUCCEED, narrating like a real one.
 * Each outbound seam (Nango proxy, HTTP-step fetch, email, Slack, MCP tool
 * calls) asks demoAmbientActive() and short-circuits to a realistic canned
 * response instead of dialling out.
 *
 * Keyed off the AMBIENT ORGANIZATION, not the browser session: the Fly worker
 * reads organizationId from the job and never sees a cookie, and both
 * execution engines already establish ambientOrganization around every run
 * (src/lib/tenant-database-context.ts). One lookup of the org's kind, cached
 * with a short TTL — a torn-down demo org simply resolves false afterwards.
 */

import { systemPrisma } from '@/lib/prisma'
import { currentAmbientOrganization } from '@/lib/tenant-database-context'

const CACHE_TTL_MS = 60_000
const kindCache = new Map<string, { demo: boolean; at: number }>()

/** Test seam: clears the kind cache between cases. */
export function clearDemoKindCache(): void {
  kindCache.clear()
}

export async function isDemoOrganization(organizationId: string): Promise<boolean> {
  const cached = kindCache.get(organizationId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.demo
  // systemPrisma: a kind lookup by pinned org id, callable from transport code
  // that runs outside any per-request tenant context (worker jobs included).
  const org = await systemPrisma.organization
    .findUnique({ where: { id: organizationId }, select: { kind: true } })
    .catch(() => null)
  const demo = org?.kind === 'demo'
  kindCache.set(organizationId, { demo, at: Date.now() })
  return demo
}

/** Whether the current execution context belongs to a demo org. */
export async function demoAmbientActive(): Promise<boolean> {
  const organizationId = currentAmbientOrganization()
  if (!organizationId) return false
  return isDemoOrganization(organizationId)
}

/**
 * Success-shaped stand-ins per transport. Static and boring on purpose: the
 * interesting content in a captured run comes from the model working over the
 * anonymised workspace, not from these envelopes.
 */
export function cannedResponse(
  kind: 'nango-proxy' | 'http' | 'email' | 'slack' | 'mcp',
  detail: { endpoint?: string; method?: string; toolName?: string } = {},
): unknown {
  switch (kind) {
    case 'nango-proxy':
      return { data: { ok: true, demo: true, endpoint: detail.endpoint ?? '', method: detail.method ?? 'GET' } }
    case 'http':
      return { ok: true, demo: true }
    case 'email':
      return { id: 'demo-delivery' }
    case 'slack':
      return { ok: true, ts: '1755600000.000100', channel: 'C0DEMO' }
    case 'mcp':
      return {
        content: [
          { type: 'text', text: `Demo mode: simulated result for ${detail.toolName ?? 'this tool'} — no external call was made.` },
        ],
      }
  }
}

/** A Response for fetch-shaped seams (HTTP step, email, Slack). */
export function cannedFetchResponse(kind: 'http' | 'email' | 'slack', detail?: { endpoint?: string }): Response {
  return new Response(JSON.stringify(cannedResponse(kind, detail)), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Fetch-shaped seam helper: the canned response in a demo context, the real
 * call otherwise. Keeps call sites to one line.
 */
export async function demoFetchOr(kind: 'http' | 'email' | 'slack', real: () => Promise<Response>): Promise<Response> {
  if (await demoAmbientActive()) return cannedFetchResponse(kind)
  return real()
}
