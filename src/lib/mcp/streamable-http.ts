import { cannedResponse, demoAmbientActive } from '@/lib/demo/transport'
/**
 * Minimal MCP StreamableHTTP client transport (JSON-RPC over POST, tolerating
 * SSE-framed responses). Auth is injected as a header provider so the same
 * transport serves the legacy Backstory service client, the per-user People.ai
 * client, and tests.
 */

export interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface StreamableHttpOptions {
  /** Resolve auth (and any extra) headers for each request. */
  getHeaders: () => Promise<Record<string, string>>
  /**
   * Called once per rpc when the server returns 401. Return true to retry the
   * request (after e.g. refreshing a token); false to fail.
   */
  onUnauthorized?: () => Promise<boolean>
  fetchImpl?: typeof fetch
  clientName?: string
  timeoutMs?: number
}

/** Parse a plain-JSON or SSE-framed JSON-RPC response body. */
export function parseRpc(text: string): any {
  const trimmed = text.trim()
  if (!trimmed) return { result: null }
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  let last: any = { result: null }
  for (const line of trimmed.split('\n')) {
    const l = line.trim()
    if (!l.startsWith('data:')) continue
    const payload = l.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      last = JSON.parse(payload)
    } catch {
      /* keep scanning */
    }
  }
  return last
}

export class StreamableHttpMcpClient {
  private readonly readyServers = new Set<string>()
  private readonly sessionIds = new Map<string, string>()
  private rpcId = 1

  constructor(private readonly options: StreamableHttpOptions) {}

  private async rpc(
    serverUrl: string,
    method: string,
    params?: Record<string, unknown>,
    notification = false,
    allowAuthRetry = true,
  ): Promise<any> {
    const fetchImpl = this.options.fetchImpl ?? fetch
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(await this.options.getHeaders()),
    }

    const sessionId = this.sessionIds.get(serverUrl)
    if (sessionId) headers['Mcp-Session-Id'] = sessionId

    const response = await fetchImpl(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(!notification ? { id: this.rpcId++ } : {}),
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    })

    if (response.status === 401 && allowAuthRetry && this.options.onUnauthorized) {
      const recovered = await this.options.onUnauthorized()
      if (recovered) return this.rpc(serverUrl, method, params, notification, false)
    }

    if (!response.ok) {
      throw new Error(`MCP server returned ${response.status} for method ${method}`)
    }

    if (method === 'initialize') {
      const sid = response.headers.get('Mcp-Session-Id')
      if (sid) this.sessionIds.set(serverUrl, sid)
    }

    if (notification) return { result: null }
    return parseRpc(await response.text())
  }

  private async initialize(serverUrl: string) {
    if (this.readyServers.has(serverUrl)) return
    const response = await this.rpc(serverUrl, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: this.options.clientName ?? 'BackstoryStudio', version: '1.0.0' },
    })
    if (response.error) throw new Error(response.error.message || 'Unable to initialize MCP server')
    await this.rpc(serverUrl, 'notifications/initialized', undefined, true)
    this.readyServers.add(serverUrl)
  }

  async getServerTools(serverUrl: string): Promise<McpToolDescriptor[]> {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/list')
    if (response.error) throw new Error(response.error.message || 'Unable to list MCP tools')
    const tools = response.result?.tools || response.result?.items || []
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? tool.input_schema,
    }))
  }

  async callTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    // Demo orgs never dial out — canned result instead (src/lib/demo/transport.ts).
    if (await demoAmbientActive()) return cannedResponse('mcp', { toolName: name })
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message || `MCP tool ${name} failed`)
    return response.result
  }
}
