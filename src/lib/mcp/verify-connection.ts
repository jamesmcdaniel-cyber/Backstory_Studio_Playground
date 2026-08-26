import { McpClient, mcpConfigFromConnection, type McpClientConfig, type McpConnectionRow } from '@/lib/mcp/mcp-client'
import { mcpClientForStoredConnection, type StoredMcpConnection } from '@/lib/mcp/connection-token'
import { createHash } from 'node:crypto'

export type McpVerification = {
  verifiedAt: Date
  toolCount: number
  toolNames: string[]
  schemaHash: string
}

/** Keep external connection failures useful without echoing credentials. */
export function safeMcpVerificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Connection failed'
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[redacted]')
    .replace(/client[_-]?secret[=:]\s*\S+/gi, 'client_secret=[redacted]')
    .slice(0, 300)
}

/** Shared by both entry points below: list the tools, then describe them. */
async function verifyTools(
  list: () => Promise<Array<{ name: string; inputSchema?: unknown; outputSchema?: unknown }>>,
): Promise<McpVerification> {
  const tools = await list()
  const schemaHash = createHash('sha256').update(JSON.stringify(
    tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )).digest('hex')
  return {
    verifiedAt: new Date(),
    toolCount: tools.length,
    toolNames: tools.slice(0, 30).map((tool) => tool.name),
    schemaHash,
  }
}

export function verifyMcpConfig(config: McpClientConfig): Promise<McpVerification> {
  return verifyTools(() => new McpClient(config).getServerTools(config.serverUrl))
}

/**
 * Verify a config assembled from a DRAFT — a create or an edit whose
 * credentials arrived in the request and are not yet the stored truth.
 *
 * There is no row to write a rotated token back to, which is why this one is
 * safe without persistence. For a connection that already exists, use
 * {@link verifyLiveMcpConnection}.
 */
export function verifyStoredMcpConnection(connection: McpConnectionRow): Promise<McpVerification> {
  return verifyMcpConfig(mcpConfigFromConnection(connection))
}

/**
 * Verify a connection that EXISTS, refreshing and saving its tokens on the way.
 *
 * The difference from the above is the whole point: an authorization-code
 * connection verified without persistence can be left worse than it was found,
 * because the refresh it triggers may consume the stored refresh token and
 * hand back a replacement nobody writes down.
 */
export async function verifyLiveMcpConnection(
  connection: StoredMcpConnection,
): Promise<McpVerification> {
  const { client, connection: fresh } = await mcpClientForStoredConnection(connection)
  return verifyTools(() => client.getServerTools(fresh.serverUrl))
}
