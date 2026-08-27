/**
 * JSON-RPC 2.0 envelope handling for the MCP server endpoint.
 *
 * Kept apart from the route so the protocol is testable without a request, a
 * session or a database — the shape of an error response is exactly the kind of
 * thing that is wrong once and then wrong forever, because nothing in our own
 * UI exercises it.
 *
 * Errors follow the JSON-RPC codes MCP clients expect. In particular a call
 * that reaches a tool and fails there is NOT a protocol error: it is a result
 * with `isError`, so the calling model reads the reason and can try something
 * else, rather than seeing a transport failure it cannot reason about.
 */

/** Latest stateless revision plus the handshake revisions we continue to serve. */
export const MCP_PROTOCOL_VERSION = '2026-07-28'
export const MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25'
export const MCP_SUPPORTED_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  '2025-06-18',
  '2025-03-26',
] as const

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
export const RPC_HEADER_MISMATCH = -32020
export const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022

export type RpcId = string | number | null

export type RpcRequest = {
  jsonrpc: '2.0'
  id?: RpcId
  method: string
  params?: Record<string, unknown>
}

export type RpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } }

export function rpcResult(id: RpcId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

/**
 * Read one JSON-RPC request out of a parsed body.
 *
 * Returns a string describing what is wrong rather than throwing, because every
 * rejection here has to become a well-formed JSON-RPC error rather than a 500.
 */
export function parseRpcRequest(body: unknown): RpcRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request must be a JSON-RPC object.'
  const candidate = body as Record<string, unknown>
  if (candidate.jsonrpc !== '2.0') return 'Only JSON-RPC 2.0 is supported.'
  if (typeof candidate.method !== 'string' || !candidate.method) return 'A method is required.'
  const id = candidate.id
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return 'id must be a string, a number, or null.'
  }
  const params = candidate.params
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return 'params must be an object.'
  }
  return {
    jsonrpc: '2.0',
    ...(id !== undefined ? { id: id as RpcId } : {}),
    method: candidate.method,
    ...(params ? { params: params as Record<string, unknown> } : {}),
  }
}

/**
 * A notification carries no id and takes no response — `notifications/initialized`
 * is sent by every client right after the handshake, and answering it with a
 * result is a protocol violation some clients treat as fatal.
 */
export function isNotification(request: RpcRequest): boolean {
  return request.id === undefined
}

/** The server's half of a legacy MCP handshake. */
export function initializeResult(serverName: string, version: string, requested?: unknown) {
  const protocolVersion = typeof requested === 'string' && MCP_SUPPORTED_VERSIONS
    .slice(1)
    .includes(requested as (typeof MCP_SUPPORTED_VERSIONS)[number])
    ? requested
    : MCP_LEGACY_PROTOCOL_VERSION
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: serverName, title: 'Backstory Studio', version },
  }
}

/** Stateless discovery response introduced by the 2026-07-28 revision. */
export function discoveryResult(serverName: string, version: string) {
  return {
    resultType: 'complete',
    supportedVersions: [...MCP_SUPPORTED_VERSIONS],
    capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
    _meta: {
      'io.modelcontextprotocol/serverInfo': { name: serverName, title: 'Backstory Studio', version },
    },
    instructions: 'Published workspace flows are tools. Long-running calls return a flowRunId for get_flow_run.',
    ttlMs: 60_000,
    cacheScope: 'private',
  }
}

export function requestProtocolVersion(request: RpcRequest): string | null {
  const meta = request.params?._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const value = (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
  return typeof value === 'string' ? value : null
}

function decodeHeaderValue(value: string | null): string | null {
  if (!value?.startsWith('=?base64?') || !value.endsWith('?=')) return value
  try {
    return Buffer.from(value.slice(9, -2), 'base64').toString('utf8')
  } catch {
    return null
  }
}

export type McpTransportValidation =
  | { ok: true; era: 'modern' | 'legacy'; protocolVersion: string }
  | { ok: false; status: 400; error: RpcResponse }

/** Validate the mirrored metadata required by modern Streamable HTTP. */
export function validateMcpTransport(
  request: RpcRequest,
  headers: Pick<Headers, 'get'>,
): McpTransportValidation {
  // An initialize request explicitly selects the legacy handshake era on a
  // dual-era endpoint. This keeps existing clients working during migration.
  if (request.method === 'initialize') {
    const requested = request.params?.protocolVersion
    const version = typeof requested === 'string' && MCP_SUPPORTED_VERSIONS.slice(1).includes(requested as never)
      ? requested
      : MCP_LEGACY_PROTOCOL_VERSION
    return { ok: true, era: 'legacy', protocolVersion: version }
  }

  const headerVersion = headers.get('mcp-protocol-version')
  const bodyVersion = requestProtocolVersion(request)
  // Headerless callers are legacy clients using our pre-session-compatible
  // endpoint. Modern metadata opts into the strict stateless contract.
  if (!headerVersion && !bodyVersion) {
    return { ok: true, era: 'legacy', protocolVersion: MCP_LEGACY_PROTOCOL_VERSION }
  }

  const id = request.id ?? null
  if (!headerVersion || !bodyVersion || headerVersion !== bodyVersion) {
    return {
      ok: false,
      status: 400,
      error: rpcError(id, RPC_HEADER_MISMATCH, 'MCP protocol version header and request metadata must match.'),
    }
  }
  if (bodyVersion !== MCP_PROTOCOL_VERSION) {
    return {
      ok: false,
      status: 400,
      error: rpcError(id, RPC_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
        supported: [...MCP_SUPPORTED_VERSIONS],
        requested: bodyVersion,
      }),
    }
  }

  const methodHeader = headers.get('mcp-method')
  if (methodHeader !== request.method) {
    return { ok: false, status: 400, error: rpcError(id, RPC_HEADER_MISMATCH, 'Mcp-Method does not match the request body.') }
  }
  if (request.method === 'tools/call') {
    const expectedName = typeof request.params?.name === 'string' ? request.params.name : ''
    if (decodeHeaderValue(headers.get('mcp-name')) !== expectedName) {
      return { ok: false, status: 400, error: rpcError(id, RPC_HEADER_MISMATCH, 'Mcp-Name does not match the request body.') }
    }
  }

  const accept = headers.get('accept')?.toLowerCase() ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    return {
      ok: false,
      status: 400,
      error: rpcError(id, RPC_INVALID_REQUEST, 'Modern MCP clients must accept application/json and text/event-stream.'),
    }
  }
  return { ok: true, era: 'modern', protocolVersion: bodyVersion }
}

/**
 * A tool result, in the content shape MCP defines.
 *
 * Everything is returned as text: a JSON payload is stringified rather than
 * sent as a bare object, because that is what the protocol carries and what
 * every client renders.
 */
export function toolResult(value: unknown, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}
