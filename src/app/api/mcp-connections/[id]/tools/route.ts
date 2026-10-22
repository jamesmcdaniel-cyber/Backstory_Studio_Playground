import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { loadMcpConnectionPlaneGroups } from '@/features/agents/tool-planes'
import { recordAudit } from '@/lib/audit'
import { redactConfig } from '@/lib/crypto/secrets'
import { needsSignIn } from '@/lib/mcp/reconnect'
import { rateLimit } from '@/lib/ratelimit'
import {
  MCP_TOOL_POLICIES,
  humanizeToolName,
  mergeToolPolicies,
  readToolPolicies,
  toolPolicyFor,
  type McpToolPolicy,
} from '@/lib/mcp/tool-policy'

// /api/mcp-connections/[id]/tools
//
// GET — the live tool list of one MCP connection. Rides the same cached
// discovery (10 min TTL per server URL) the agent runtime uses, so the list a
// person sees is exactly the list a run would load.
//   - default: what runs can use (tools turned off in Integrations withheld) —
//     the agent form's per-tool toggle popover.
//   - ?all=1:  every tool the server offers with its permission, plus the
//     connection's status — the Integrations detail view that sets them.
//
// PATCH — set per-tool permissions: { tools: { [name]: 'allow'|'approve'|'off' } }.

const connectionIdOf = (request: Request) => new URL(request.url).pathname.split('/').at(-2)

/** The row, if the caller can see it: org-shared, or their own personal row. */
async function visibleConnection(id: string, auth: AuthContext) {
  return prisma.mcpConnection.findFirst({
    where: { id, organizationId: auth.organizationId, OR: [{ userId: null }, { userId: auth.dbUser.id }] },
  })
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = connectionIdOf(request)
  if (!id) throw new ApiError('Connection id is required')
  const all = request.nextUrl.searchParams.get('all') === '1'

  if (!all) {
    const [group] = await loadMcpConnectionPlaneGroups(auth.organizationId, auth.dbUser.id, { connectionIds: [id] })
    if (!group) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
    if (group.toolsError) return { success: false as const, error: group.toolsError }
    return {
      success: true as const,
      items: group.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    }
  }

  const conn = await visibleConnection(id, auth)
  if (!conn) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  const redacted = redactConfig(conn.authType, conn.authConfig)
  const connection = {
    id: conn.id,
    name: conn.name,
    description: conn.description,
    provider: conn.provider,
    serverUrl: conn.serverUrl,
    isActive: conn.isActive,
    healthStatus: conn.healthStatus,
    lastError: conn.lastError,
    lastVerifiedAt: conn.lastVerifiedAt,
    needsSignIn: needsSignIn({ id: conn.id, provider: conn.provider, auth: redacted }),
    // Who may change permissions: the owner of a personal row; a workspace
    // integration manager for a shared one. The view goes read-only otherwise.
    canManage: conn.userId ? conn.userId === auth.dbUser.id : auth.can('integration.manage'),
    // Edit and Disconnect go through PUT/DELETE, which take integration.manage
    // on top of ownership — so a member can tune their own server's tools but
    // not remove it.
    canEdit: auth.can('integration.manage') && (!conn.userId || conn.userId === auth.dbUser.id),
  }
  if (!conn.isActive) {
    return { success: false as const, error: 'This server is turned off. Turn it back on to see its tools.', connection, items: [] }
  }
  const [group] = await loadMcpConnectionPlaneGroups(auth.organizationId, auth.dbUser.id, { connectionIds: [id], includeBlocked: true })
  if (!group) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (group.toolsError) return { success: false as const, error: group.toolsError, connection, items: [] }
  const policies = readToolPolicies(conn.toolPolicies)
  return {
    success: true as const,
    connection,
    items: group.tools.map((tool) => ({
      name: tool.name,
      title: tool.title || humanizeToolName(tool.name),
      // The plane defaults a missing description to "<name> via <server>",
      // which is noise in a list that already names both.
      description: tool.description === `${tool.name} via ${group.name}` ? '' : tool.description,
      ...(typeof tool.annotations?.readOnlyHint === 'boolean' ? { readOnly: tool.annotations.readOnlyHint } : {}),
      ...(typeof tool.annotations?.destructiveHint === 'boolean' ? { destructive: tool.annotations.destructiveHint } : {}),
      policy: toolPolicyFor(policies, tool.name),
    })),
  }
}, { permission: 'flow.read' })

const patchSchema = z.object({
  tools: z
    .record(z.string().min(1).max(200), z.enum(MCP_TOOL_POLICIES as [McpToolPolicy, ...McpToolPolicy[]]))
    .refine((tools) => Object.keys(tools).length > 0, { message: 'Name at least one tool' })
    .refine((tools) => Object.keys(tools).length <= 500, { message: 'Too many tools in one change' }),
})

const CAS_ATTEMPTS = 4

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`mcp-tool-policy:${auth.dbUser.id}`, { limit: 60, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many permission changes — slow down.', 429, 'RATE_LIMITED')

  const id = connectionIdOf(request)
  if (!id) throw new ApiError('Connection id is required')
  const body = patchSchema.parse(await request.json().catch(() => ({})))

  // Allowed on platform-managed rows too: which tools may run is policy, not
  // the connection's configuration (which PUT refuses to edit on those).
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const existing = await visibleConnection(id, auth)
    // Another member's personal row is indistinguishable from a missing one.
    if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
    if (!existing.userId && !auth.can('integration.manage')) {
      throw new ApiError('Only a workspace admin can change the tools of a shared server.', 403, 'FORBIDDEN')
    }
    const before = readToolPolicies(existing.toolPolicies)
    const after = mergeToolPolicies(before, body.tools)
    // Compare-and-set on updatedAt: two people toggling different tools at once
    // must both land, not have the later write erase the earlier one.
    const updated = await prisma.mcpConnection.updateMany({
      where: { id: existing.id, organizationId: auth.organizationId, updatedAt: existing.updatedAt },
      data: { toolPolicies: after as Prisma.InputJsonValue },
    })
    if (updated.count !== 1) continue

    const changed = Object.fromEntries(
      Object.entries(body.tools).filter(([name, policy]) => toolPolicyFor(before, name) !== policy),
    )
    if (Object.keys(changed).length) {
      await recordAudit({
        organizationId: auth.organizationId,
        actorUserId: auth.dbUser.id,
        action: 'mcp_connection.tool_policy_changed',
        resourceType: 'mcp_connection',
        resourceId: existing.id,
        detail: {
          name: existing.name,
          changes: Object.fromEntries(Object.entries(changed).map(([name, policy]) => [name, { from: toolPolicyFor(before, name), to: policy }])),
        },
      })
    }
    return { success: true as const, policies: after }
  }
  throw new ApiError('Someone else changed this server at the same moment — try again.', 409, 'CONFLICT')
}, { permission: 'flow.read' })
