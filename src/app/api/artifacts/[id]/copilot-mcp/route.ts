import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { requireEditable } from '@/lib/artifacts/route-access'
import { addCopilotMcpServer, copilotMcpInputSchema, listCopilotMcpServers, removeCopilotMcpServer, testCopilotMcpServer } from '@/lib/artifacts/copilot-mcp'
import { rateLimit } from '@/lib/ratelimit'
import type { AuthContext } from '@/lib/server/auth'

export const runtime = 'nodejs'

// /api/artifacts/:id/copilot-mcp — the MCP servers the owner of a shared-
// template copy connected for its copilot, with their own credentials. Only
// the copy's owner reaches it (requireEditable: a personal copy is editable by
// its owner alone); secrets are write-only.

async function copyId(request: Request, auth: AuthContext): Promise<string> {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  const artifact = await requireEditable(auth, id)
  if (!artifact.templateSourceId) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return id
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  return { success: true, servers: await listCopilotMcpServers(auth.organizationId, await copyId(request, auth)) }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = await copyId(request, auth)
  const limited = await rateLimit(`copilot-mcp:${auth.organizationId}:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Please wait a minute before trying again.', 429, 'RATE_LIMITED')
  const body = await request.json().catch(() => null) as { test?: unknown } | null
  const input = copilotMcpInputSchema.safeParse(body)
  if (!input.success) throw new ApiError('Enter a valid server address.', 400, 'INVALID_BODY')
  // { test: true }: "Test connection" — the server's tools, nothing stored.
  if (body?.test === true) return { success: true, test: await testCopilotMcpServer(auth.organizationId, id, input.data) }
  return { success: true, servers: await addCopilotMcpServer(auth.organizationId, id, input.data) }
}, { permission: 'agent.read' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = await copyId(request, auth)
  const body = z.object({ serverId: z.string().min(1).max(64) }).safeParse(await request.json().catch(() => null))
  if (!body.success) throw new ApiError('Server id is required.', 400, 'INVALID_BODY')
  return { success: true, servers: await removeCopilotMcpServer(auth.organizationId, id, body.data.serverId) }
}, { permission: 'agent.read' })
