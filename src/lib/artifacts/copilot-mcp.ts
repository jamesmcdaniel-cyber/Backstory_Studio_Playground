import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { buildAuthConfig } from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { safeMcpVerificationError, verifyStoredMcpConnection } from '@/lib/mcp/verify-connection'
import { apiLogger } from '@/lib/logger'
import type { CopilotMcpServerView } from './types'

/**
 * A shared-template copy's OWN data sources: MCP servers the person using the
 * copy connected themselves, with their own credentials — an anonymous visitor
 * on a public link, or someone signed in.
 *
 * They live on the copy (Artifact.copilotMcpServers), never in
 * the workspace's McpConnection table: a visitor's server must not appear on
 * the host workspace's connections page, be offered to its agents or flows, or
 * outlive the copy. Secrets are encrypted exactly as a workspace connection's
 * are. Once a copy has any, its copilot queries ONLY these — the workspace's
 * shareable demo servers are no longer loaded, so a visitor's data and the
 * demo data never meet on one page.
 */

export const COPILOT_MCP_MAX = 3
/** Tools taken from one server, matching the shareable-server cap. */
const TOOLS_PER_SERVER = 20

const storedServerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  serverUrl: z.string().url().max(2_000),
  authType: z.enum(['none', 'api_key', 'oauth2']),
  authConfig: z.record(z.unknown()).default({}),
  toolCount: z.number().int().nonnegative().default(0),
  addedAt: z.string(),
})
type StoredServer = z.infer<typeof storedServerSchema>

/** What the person connecting a server sends: its address and their own credential for it. */
export const copilotMcpInputSchema = z.object({
  serverUrl: z.string().trim().url().max(2_000),
  name: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  authType: z.enum(['none', 'api_key', 'oauth2']).default('none'),
  // api_key: a key or bearer token, and the header it travels in.
  apiKey: z.string().max(4_000).optional(),
  headerName: z.string().trim().max(100).optional(),
  // oauth2: client credentials. The token address is discovered from the
  // server when left out, as on the workspace's own connections.
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().max(4_000).optional(),
  tokenUrl: z.string().trim().url().max(2_000).optional(),
  scopes: z.string().trim().max(1_000).optional(),
})
export type CopilotMcpInput = z.infer<typeof copilotMcpInputSchema>

/** The servers stored on a copy (the column's value). A malformed entry is dropped, never trusted. */
export function readCopilotMcpServers(stored: unknown): StoredServer[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((entry) => {
    const parsed = storedServerSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  }).slice(0, COPILOT_MCP_MAX)
}

/** What is shown back: where it points and how it signs in — never a secret. */
export function copilotMcpViews(stored: unknown): CopilotMcpServerView[] {
  return readCopilotMcpServers(stored).map((server) => ({ id: server.id, name: server.name, ...(server.description ? { description: server.description } : {}), serverUrl: server.serverUrl, authType: server.authType, toolCount: server.toolCount }))
}

async function requirePublic(url: string, field: string) {
  try {
    await assertPublicUrl(url)
  } catch (error) {
    if (error instanceof SsrfError) throw new ApiError(`${field} is not allowed: ${error.message}`, 400, 'INVALID_URL')
    throw error
  }
}

/** The copy, when it is one: these servers exist only on shared-template copies. */
async function copyRow(organizationId: string, artifactId: string) {
  const row = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId, templateSourceId: { not: null }, archivedAt: null }, select: { id: true, copilotMcpServers: true, updatedAt: true } })
  if (!row) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return row
}

const SAVE_ATTEMPTS = 3

/**
 * The list is one JSON column rewritten whole, so a write lands only if the
 * row is still the one `change` was computed from (a compare-and-swap on
 * updatedAt); otherwise the fresh list is read and the change recomputed.
 * Two tabs connecting and removing at once each keep the other's result.
 */
async function saveServers(organizationId: string, artifactId: string, change: (servers: StoredServer[]) => StoredServer[]): Promise<StoredServer[]> {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    const row = await copyRow(organizationId, artifactId)
    const servers = change(readCopilotMcpServers(row.copilotMcpServers))
    const written = await prisma.artifact.updateMany({ where: { id: artifactId, organizationId, updatedAt: row.updatedAt }, data: { copilotMcpServers: servers as unknown as Prisma.InputJsonValue } })
    if (written.count) return servers
  }
  throw new ApiError('The copy changed while saving. Try again.', 409, 'CONFLICT')
}

/**
 * Check what was entered and ask the server for its tools with it. Nothing is
 * stored: the address must be a public https one, the credential must be there
 * for the chosen sign-in, and the server must answer.
 */
async function verifyInput(input: CopilotMcpInput) {
  if (new URL(input.serverUrl).protocol !== 'https:') throw new ApiError('The server address must start with https://.', 400, 'INVALID_URL')
  await requirePublic(input.serverUrl, 'Server address')
  if (input.authType === 'api_key' && !input.apiKey?.trim()) throw new ApiError('Enter the access token for this server.', 400, 'CREDENTIAL_REQUIRED')
  if (input.authType === 'oauth2') {
    if (!input.clientId || !input.clientSecret?.trim()) throw new ApiError('Enter the client ID and client secret for this server.', 400, 'CREDENTIAL_REQUIRED')
    if (input.tokenUrl) await requirePublic(input.tokenUrl, 'Token address')
  }
  const authConfig = buildAuthConfig({
    authType: input.authType,
    apiKey: input.apiKey?.trim(),
    headerName: input.headerName || undefined,
    clientId: input.clientId,
    clientSecret: input.clientSecret?.trim(),
    tokenUrl: input.tokenUrl || undefined,
    scopes: input.scopes || undefined,
    ...(input.authType === 'oauth2' ? { flow: 'client_credentials' as const } : {}),
  })
  try {
    return { authConfig, verification: await verifyStoredMcpConnection({ serverUrl: input.serverUrl, authType: input.authType, authConfig }) }
  } catch (error) {
    throw new ApiError(`The server could not be reached with those details: ${safeMcpVerificationError(error)}`, 422, 'CONNECTION_VERIFICATION_FAILED')
  }
}

/** "Test connection": the tools the server answers with, for a copy the caller has shown is theirs. Stores nothing. */
export async function testCopilotMcpServer(organizationId: string, artifactId: string, input: CopilotMcpInput): Promise<{ toolCount: number; toolNames: string[] }> {
  await copyRow(organizationId, artifactId)
  const { verification } = await verifyInput(input)
  return { toolCount: verification.toolCount, toolNames: verification.toolNames }
}

/**
 * Connect a server to a copy. The caller has already shown the copy is theirs
 * (its owner, or the visitor whose cookie opens it). The address must be a
 * public https one and the server must answer with its tools before anything
 * is stored.
 */
export async function addCopilotMcpServer(organizationId: string, artifactId: string, input: CopilotMcpInput): Promise<CopilotMcpServerView[]> {
  const room = (servers: StoredServer[]) => {
    if (servers.length >= COPILOT_MCP_MAX) throw new ApiError(`A copy can have up to ${COPILOT_MCP_MAX} servers. Remove one first.`, 400, 'MCP_LIMIT_REACHED')
    if (servers.some((server) => server.serverUrl === input.serverUrl)) throw new ApiError('That server is already connected.', 400, 'MCP_DUPLICATE')
  }
  // Checked before the (slow) verification so an obvious refusal is quick,
  // and again on the list the write is made from.
  room(readCopilotMcpServers((await copyRow(organizationId, artifactId)).copilotMcpServers))
  const { authConfig, verification } = await verifyInput(input)
  const toolCount = verification.toolCount
  const server: StoredServer = { id: randomUUID(), name: input.name || new URL(input.serverUrl).hostname, ...(input.description ? { description: input.description } : {}), serverUrl: input.serverUrl, authType: input.authType, authConfig, toolCount, addedAt: new Date().toISOString() }
  const saved = await saveServers(organizationId, artifactId, (servers) => { room(servers); return [...servers, server] })
  return copilotMcpViews(saved)
}

/** Disconnect a server from a copy; its stored credential goes with it. */
export async function removeCopilotMcpServer(organizationId: string, artifactId: string, serverId: string): Promise<CopilotMcpServerView[]> {
  const saved = await saveServers(organizationId, artifactId, (servers) => servers.filter((server) => server.id !== serverId))
  return copilotMcpViews(saved)
}

export async function listCopilotMcpServers(organizationId: string, artifactId: string): Promise<CopilotMcpServerView[]> {
  return copilotMcpViews((await copyRow(organizationId, artifactId)).copilotMcpServers)
}

export type CopilotMcpGroup = { name: string; serverUrl: string; client: McpClient; tools: Array<{ name: string; description: string; inputSchema: unknown }> }

/**
 * A copy's own servers, ready for its copilot's run. `null` when the copy has
 * none (the caller then falls back to the workspace's shareable demo servers);
 * an array — possibly of unreachable, tool-less servers — when it has, so a
 * server that is down never silently swaps the person's data for demo data.
 * Tool lists are not cached: they depend on the visitor's own credential.
 */
export async function loadCopilotMcpGroups(organizationId: string, artifactId: string): Promise<CopilotMcpGroup[] | null> {
  const row = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId, templateSourceId: { not: null } }, select: { copilotMcpServers: true } })
  const servers = readCopilotMcpServers(row?.copilotMcpServers)
  if (!servers.length) return null
  return Promise.all(servers.map(async (server): Promise<CopilotMcpGroup> => {
    const client = new McpClient(mcpConfigFromConnection(server))
    try {
      const tools = await client.getServerTools(server.serverUrl)
      return { name: server.name, serverUrl: server.serverUrl, client, tools: tools.slice(0, TOOLS_PER_SERVER).map((tool) => ({ name: tool.name, description: tool.description || `${tool.name} via ${server.name}`, inputSchema: tool.inputSchema || { type: 'object', properties: {} } })) }
    } catch (error) {
      apiLogger.warn('copilot MCP: a copy\'s own server could not be reached, skipping', { organizationId, artifactId, error: safeMcpVerificationError(error) })
      return { name: server.name, serverUrl: server.serverUrl, client, tools: [] }
    }
  }))
}
