import { McpClient, mcpConfigFromConnection, type McpClientConfig, type McpConnectionRow } from '@/lib/mcp/mcp-client'
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

export async function verifyMcpConfig(config: McpClientConfig): Promise<McpVerification> {
  const tools = await new McpClient(config).getServerTools(config.serverUrl)
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

export function verifyStoredMcpConnection(connection: McpConnectionRow): Promise<McpVerification> {
  return verifyMcpConfig(mcpConfigFromConnection(connection))
}
