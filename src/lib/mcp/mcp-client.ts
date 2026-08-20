/**
 * Generic MCP client — supports three auth methods:
 *   - none      : no auth header
 *   - api_key   : static Bearer or custom header
 *   - oauth2    : client-credentials flow with auto-discovery + token cache
 *
 * Implements the McpToolClient interface used by execute-agent.ts so it can
 * be held in a ToolBinding.client without any casting.
 *
 * mcpConfigFromConnection() decrypts an McpConnection.authConfig blob into the
 * constructor's runtime config shape.
 */

import { decryptSecret } from '@/lib/crypto/secrets'
import { refreshAccessToken } from '@/lib/mcp/oauth-authcode'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { cannedResponse, demoAmbientActive } from '@/lib/demo/transport'

// ---------------------------------------------------------------------------
// Runtime config (constructor argument — secrets already decrypted)
// ---------------------------------------------------------------------------

export interface McpClientConfig {
  serverUrl: string
  authType: 'none' | 'api_key' | 'oauth2'
  // api_key fields
  apiKey?: string
  headerName?: string
  // oauth2 (client-credentials) fields
  clientId?: string
  clientSecret?: string
  tokenUrl?: string
  scopes?: string
  // oauth2 authorization-code flow fields ('flow' === 'authcode')
  // Set when the connection was created via the user-consent / Okta SSO flow.
  flow?: 'authcode'
  tokenEndpoint?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number // ms since epoch — when the stored accessToken expires
  // Optional sink called after an authcode refresh so rotated tokens can be
  // persisted (e.g. back to the McpConnection row). Best-effort: failures here
  // must not abort the run. Injected by the caller to keep this client free of
  // any persistence/Prisma dependency.
  persistTokens?: (tokens: {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }) => Promise<void>
}

// ---------------------------------------------------------------------------
// Token cache (per-instance so different orgs/connections don't share tokens)
// ---------------------------------------------------------------------------

interface CachedToken {
  value: string
  expiresAt: number // ms since epoch
}

// Max token lifetime regardless of what the server reports (24 h)
const MAX_TOKEN_TTL_S = 24 * 60 * 60

// ---------------------------------------------------------------------------
// SSE / JSON-RPC response parser (mirrors backstory-mcp.ts)
// ---------------------------------------------------------------------------

function parseRpc(text: string): any {
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

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  private readonly config: McpClientConfig
  private readonly readyServers = new Set<string>()
  private readonly sessionIds = new Map<string, string>()
  private rpcId = 1

  // Per-instance OAuth token cache + in-flight coalescer
  private tokenCache: CachedToken | null = null
  private inFlightToken: Promise<string> | null = null

  constructor(config: McpClientConfig) {
    this.config = config
  }

  // --------------------------------------------------------------------------
  // OAuth token handling (client-credentials)
  // --------------------------------------------------------------------------

  private async fetchAccessToken(): Promise<string> {
    const { clientId, clientSecret, tokenUrl, scopes, serverUrl } = this.config

    if (!clientId || !clientSecret) {
      throw new Error('MCP connection oauth2: clientId and clientSecret are required')
    }

    // Resolve token endpoint: use explicit tokenUrl or auto-discover
    let resolvedTokenUrl = tokenUrl
    if (!resolvedTokenUrl) {
      const origin = new URL(serverUrl).origin
      const discoveryUrl = `${origin}/.well-known/oauth-authorization-server`
      await assertPublicUrl(discoveryUrl)
      const discoveryResp = await fetch(discoveryUrl, {
        redirect: 'error', // don't let a 3xx bounce us to an internal host
        signal: AbortSignal.timeout(10_000),
      })
      if (!discoveryResp.ok) {
        throw new Error(
          `MCP connection oauth2: token endpoint not configured and auto-discovery failed (status ${discoveryResp.status})`,
        )
      }
      const meta = (await discoveryResp.json()) as { token_endpoint?: string }
      if (!meta.token_endpoint) {
        throw new Error(
          'MCP connection oauth2: oauth-authorization-server metadata did not include token_endpoint',
        )
      }
      resolvedTokenUrl = meta.token_endpoint
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    })
    if (scopes) body.set('scope', scopes)

    // Send both body credentials and HTTP Basic auth — different OAuth servers
    // require different styles and including both is safe.
    const basicCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

    // Re-validate at fetch time (tokenUrl may be a discovered endpoint, and this
    // guards against DNS rebinding since save).
    await assertPublicUrl(resolvedTokenUrl)
    const response = await fetch(resolvedTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicCredentials}`,
      },
      body: body.toString(),
      redirect: 'error', // don't follow a 3xx to an internal host
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      // Never echo the raw response body — it may carry sensitive detail
      throw new Error(`MCP connection oauth2: token request failed with status ${response.status}`)
    }

    const data = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!data.access_token) {
      throw new Error('MCP connection oauth2: token response did not include access_token')
    }

    const rawExpiresIn =
      typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600
    const expiresIn = Math.min(rawExpiresIn, MAX_TOKEN_TTL_S)

    this.tokenCache = {
      value: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    }

    return this.tokenCache.value
  }

  private async getOAuthToken(): Promise<string> {
    // Return cached token if still valid (60-second safety buffer)
    if (this.tokenCache && this.tokenCache.expiresAt - Date.now() > 60_000) {
      return this.tokenCache.value
    }

    // Coalesce concurrent refreshes into a single in-flight Promise
    if (this.inFlightToken) return this.inFlightToken

    this.inFlightToken = this.fetchAccessToken()
    try {
      return await this.inFlightToken
    } finally {
      this.inFlightToken = null
    }
  }

  // --------------------------------------------------------------------------
  // OAuth token handling (authorization-code flow / Okta SSO)
  // --------------------------------------------------------------------------

  /**
   * Return a valid bearer token for an authorization-code (Okta SSO)
   * connection. Uses the stored access token when it is still valid for >60s;
   * otherwise exchanges the refresh token for a fresh access token (in-memory
   * for this run only).
   */
  private async getAuthCodeToken(): Promise<string> {
    const { accessToken, refreshToken, clientId, clientSecret, tokenEndpoint, expiresAt } =
      this.config

    // Use the stored access token if it has more than a 60s safety margin.
    if (accessToken && typeof expiresAt === 'number' && expiresAt - Date.now() > 60_000) {
      return accessToken
    }

    // Otherwise refresh. Coalesce concurrent refreshes into one request.
    if (this.inFlightToken) return this.inFlightToken

    if (!refreshToken || !clientId || !tokenEndpoint) {
      throw new Error(
        'MCP connection authcode: missing refreshToken/clientId/tokenEndpoint to refresh access token',
      )
    }

    this.inFlightToken = (async () => {
      const tokens = await refreshAccessToken(tokenEndpoint, {
        clientId,
        clientSecret,
        refreshToken,
      })
      this.tokenCache = {
        value: tokens.access_token,
        expiresAt:
          Date.now() +
          (typeof tokens.expires_in === 'number' && tokens.expires_in > 0
            ? Math.min(tokens.expires_in, MAX_TOKEN_TTL_S)
            : 3600) *
            1000,
      }
      // Persist the rotated tokens so the next run (and any later refresh in
      // this run) reuse them. Best-effort — the in-memory token above already
      // carries this run, so a persistence failure must not break the call.
      if (this.config.persistTokens) {
        try {
          await this.config.persistTokens(tokens)
        } catch (err) {
          // Swallow: the run continues on the in-memory token.
          void err
        }
      }
      return tokens.access_token
    })()

    try {
      return await this.inFlightToken
    } finally {
      this.inFlightToken = null
    }
  }

  // --------------------------------------------------------------------------
  // Auth header computation
  // --------------------------------------------------------------------------

  private async authHeaders(): Promise<Record<string, string>> {
    const { authType, apiKey, headerName, flow } = this.config

    if (authType === 'none') {
      return {}
    }

    if (authType === 'api_key') {
      if (!apiKey) return {}
      // If headerName is empty / not set, or explicitly "Authorization", use Bearer
      const effectiveHeader =
        !headerName || headerName.trim() === '' || headerName === 'Authorization'
          ? 'Authorization'
          : headerName

      if (effectiveHeader === 'Authorization') {
        return { Authorization: `Bearer ${apiKey}` }
      }
      return { [effectiveHeader]: apiKey }
    }

    if (authType === 'oauth2') {
      // Authorization-code (Okta SSO) connections carry their own
      // access/refresh tokens; client-credentials connections fetch one.
      if (flow === 'authcode') {
        // Prefer a token refreshed earlier in this run, if still valid.
        if (this.tokenCache && this.tokenCache.expiresAt - Date.now() > 60_000) {
          return { Authorization: `Bearer ${this.tokenCache.value}` }
        }
        const token = await this.getAuthCodeToken()
        return { Authorization: `Bearer ${token}` }
      }
      const token = await this.getOAuthToken()
      return { Authorization: `Bearer ${token}` }
    }

    return {}
  }

  // --------------------------------------------------------------------------
  // Low-level JSON-RPC over HTTP (mirrors backstory-mcp.ts rpc())
  // --------------------------------------------------------------------------

  private async rpc(
    serverUrl: string,
    method: string,
    params?: Record<string, unknown>,
    notification = false,
  ) {
    const auth = await this.authHeaders()

    const headers: Record<string, string> = {
      ...auth,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }

    const sessionId = this.sessionIds.get(serverUrl)
    if (sessionId) headers['Mcp-Session-Id'] = sessionId

    const response = await fetch(serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(!notification ? { id: this.rpcId++ } : {}),
        method,
        ...(params ? { params } : {}),
      }),
      redirect: 'error', // a 3xx to an internal host would bypass the SSRF guard
      signal: AbortSignal.timeout(30_000),
    })

    if (!response.ok) {
      throw new Error(`MCP server returned ${response.status} for method ${method}`)
    }

    // Capture session id from initialize response (if provided)
    if (method === 'initialize') {
      const sid = response.headers.get('Mcp-Session-Id')
      if (sid) this.sessionIds.set(serverUrl, sid)
    }

    if (notification) return { result: null }
    return parseRpc(await response.text())
  }

  // --------------------------------------------------------------------------
  // MCP initialize handshake
  // --------------------------------------------------------------------------

  private async initialize(serverUrl: string) {
    if (this.readyServers.has(serverUrl)) return
    // SSRF guard: this serverUrl is user-provided (custom MCP connections), so
    // validate it points at a public host before any request to it. Covers all
    // subsequent rpc() calls for this server.
    await assertPublicUrl(serverUrl)
    const response = await this.rpc(serverUrl, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'BackstoryStudio', version: '1.0.0' },
    })
    if (response.error) {
      throw new Error(response.error.message || 'Unable to initialize MCP server')
    }
    await this.rpc(serverUrl, 'notifications/initialized', undefined, true)
    this.readyServers.add(serverUrl)
  }

  // --------------------------------------------------------------------------
  // Public McpToolClient interface
  // --------------------------------------------------------------------------

  async getServerTools(
    serverUrl: string,
  ): Promise<{ name: string; description?: string; inputSchema?: any; outputSchema?: any }[]> {
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/list')
    if (response.error) {
      throw new Error(response.error.message || 'Unable to list MCP tools')
    }
    const tools = response.result?.tools || response.result?.items || []
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ||
        tool.input_schema ||
        tool.parameters || { type: 'object', properties: {} },
      outputSchema: tool.outputSchema ||
        tool.output_schema ||
        tool.resultSchema ||
        tool.result_schema,
    }))
  }

  async executeTool(
    serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    // Demo orgs never dial an MCP server — their connection rows are
    // credential-free shells (src/lib/demo/transport.ts).
    if (await demoAmbientActive()) return cannedResponse('mcp', { toolName: name })
    await this.initialize(serverUrl)
    const response = await this.rpc(serverUrl, 'tools/call', { name, arguments: args })
    if (response.error) {
      throw new Error(response.error.message || `Tool ${name} failed`)
    }
    return response.result
  }
}

// ---------------------------------------------------------------------------
// mcpConfigFromConnection — decrypt an McpConnection row → McpClientConfig
// ---------------------------------------------------------------------------

/**
 * Shape of McpConnection.authConfig as stored in the DB.
 * Secrets (apiKey, clientSecret) are encrypted with encryptSecret().
 */
interface StoredAuthConfig {
  apiKey?: string
  headerName?: string
  clientId?: string
  clientSecret?: string
  tokenUrl?: string
  scopes?: string
  // authorization-code flow (Okta SSO) fields
  flow?: 'authcode'
  tokenEndpoint?: string
  accessToken?: string // encrypted
  refreshToken?: string // encrypted
  expiresAt?: number
}

export interface McpConnectionRow {
  serverUrl: string
  authType: string
  authConfig: unknown
}

export function mcpConfigFromConnection(conn: McpConnectionRow): McpClientConfig {
  const authType = conn.authType as 'none' | 'api_key' | 'oauth2'

  const stored: StoredAuthConfig =
    conn.authConfig && typeof conn.authConfig === 'object' && !Array.isArray(conn.authConfig)
      ? (conn.authConfig as StoredAuthConfig)
      : {}

  if (authType === 'none') {
    return { serverUrl: conn.serverUrl, authType: 'none' }
  }

  if (authType === 'api_key') {
    return {
      serverUrl: conn.serverUrl,
      authType: 'api_key',
      apiKey: stored.apiKey ? decryptSecret(stored.apiKey) : undefined,
      headerName: stored.headerName,
    }
  }

  if (authType === 'oauth2') {
    // Authorization-code (Okta SSO) connection: decrypt the stored tokens so
    // the client can present a valid bearer (and refresh when expired).
    if (stored.flow === 'authcode') {
      return {
        serverUrl: conn.serverUrl,
        authType: 'oauth2',
        flow: 'authcode',
        clientId: stored.clientId,
        clientSecret: stored.clientSecret ? decryptSecret(stored.clientSecret) : undefined,
        tokenEndpoint: stored.tokenEndpoint,
        accessToken: stored.accessToken ? decryptSecret(stored.accessToken) : undefined,
        refreshToken: stored.refreshToken ? decryptSecret(stored.refreshToken) : undefined,
        expiresAt: stored.expiresAt,
      }
    }

    return {
      serverUrl: conn.serverUrl,
      authType: 'oauth2',
      clientId: stored.clientId,
      clientSecret: stored.clientSecret ? decryptSecret(stored.clientSecret) : undefined,
      tokenUrl: stored.tokenUrl,
      scopes: stored.scopes,
    }
  }

  // Unknown authType — treat as unauthenticated
  return { serverUrl: conn.serverUrl, authType: 'none' }
}
