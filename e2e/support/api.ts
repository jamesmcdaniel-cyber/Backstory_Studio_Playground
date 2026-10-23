/**
 * Calls a journey makes to the app's own API, as the signed-in test user.
 *
 * Two uses only, both deliberately narrow:
 *
 *  1. ASKING the server a fact the page under test should agree with (which
 *     permissions this session resolved, which MCP servers answer) — so an
 *     assertion compares the UI against the server rather than against a
 *     constant baked into the spec.
 *  2. CLEANING UP after a journey through the same routes the product uses.
 *     Unlike the database helpers in seed.ts this needs no extra secret, so a
 *     CI run with only the five required secrets still leaves the workspace as
 *     it found it — and deleting a flow cascades its runs, which hands the
 *     test user's daily run allowance back.
 *
 * Every helper takes a Playwright `APIRequestContext` (page.request), which
 * shares the browser context's cookies — the same session the page holds.
 */
import type { APIRequestContext } from '@playwright/test'

export async function sessionPermissions(request: APIRequestContext): Promise<Set<string>> {
  const response = await request.get('/api/auth/context')
  if (!response.ok()) throw new Error(`/api/auth/context answered ${response.status()}: ${await response.text()}`)
  const { context } = (await response.json()) as { context: { permissions: string[] } }
  return new Set(context.permissions)
}

/** Delete a flow by id. Idempotent: a flow already gone is not an error. */
export async function deleteFlow(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete('/api/flows', { data: { id } })
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Cleaning up flow ${id} failed (${response.status()}): ${await response.text()}`)
  }
}

/** Delete every flow in this workspace whose name starts with `prefix`. */
export async function deleteFlowsByPrefix(request: APIRequestContext, prefix: string): Promise<void> {
  const response = await request.get('/api/flows')
  if (!response.ok()) return
  const { flows = [] } = (await response.json()) as { flows?: Array<{ id: string; name: string }> }
  for (const flow of flows.filter((entry) => entry.name.startsWith(prefix))) await deleteFlow(request, flow.id)
}

/** Delete an agent by id (the product soft-deletes). Idempotent. */
export async function deleteAgent(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete('/api/agents', { data: { id } })
  if (!response.ok() && response.status() !== 404) {
    throw new Error(`Cleaning up agent ${id} failed (${response.status()}): ${await response.text()}`)
  }
}

/** Delete every agent in this workspace whose title starts with `prefix`. */
export async function deleteAgentsByPrefix(request: APIRequestContext, prefix: string): Promise<void> {
  const response = await request.get('/api/agents')
  if (!response.ok()) return
  const body = (await response.json()) as { agents?: Array<{ id: string; title: string }> }
  for (const agent of (body.agents ?? []).filter((entry) => entry.title?.startsWith(prefix))) await deleteAgent(request, agent.id)
}

export interface McpServerSummary {
  id: string
  name: string
  isActive: boolean
  lastVerifiedAt: string | null
  healthStatus: string
}

/** The MCP servers this session can see, as the Integrations page lists them. */
export async function mcpServers(request: APIRequestContext): Promise<McpServerSummary[]> {
  const response = await request.get('/api/mcp-connections')
  if (!response.ok()) throw new Error(`/api/mcp-connections answered ${response.status()}: ${await response.text()}`)
  return ((await response.json()) as { connections: McpServerSummary[] }).connections
}

export type ToolPolicy = 'allow' | 'approve' | 'off'

export interface McpServerTools {
  success: boolean
  error?: string
  items: Array<{ name: string; title: string; policy: ToolPolicy }>
}

export async function mcpServerTools(request: APIRequestContext, id: string): Promise<McpServerTools> {
  const response = await request.get(`/api/mcp-connections/${encodeURIComponent(id)}/tools?all=1`)
  const body = (await response.json().catch(() => ({}))) as Partial<McpServerTools>
  return { success: Boolean(response.ok() && body.success), error: body.error, items: body.items ?? [] }
}

export async function setToolPolicy(request: APIRequestContext, id: string, tool: string, policy: ToolPolicy): Promise<void> {
  const response = await request.patch(`/api/mcp-connections/${encodeURIComponent(id)}/tools`, { data: { tools: { [tool]: policy } } })
  if (!response.ok()) throw new Error(`Restoring ${tool} on ${id} failed (${response.status()}): ${await response.text()}`)
}

/** Revoke every pending invitation in this workspace whose address starts with `prefix`. */
export async function revokeInvitationsByPrefix(request: APIRequestContext, prefix: string): Promise<void> {
  const response = await request.get('/api/organizations/invitations')
  if (!response.ok()) return
  const { invitations = [] } = (await response.json()) as { invitations?: Array<{ id: string; email: string }> }
  for (const invitation of invitations.filter((entry) => entry.email.startsWith(prefix))) {
    await request.delete(`/api/organizations/invitations/${encodeURIComponent(invitation.id)}`)
  }
}
