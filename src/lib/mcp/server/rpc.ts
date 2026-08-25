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

export const MCP_PROTOCOL_VERSION = '2024-11-05'

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

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

/** The server's half of the MCP handshake. */
export function initializeResult(serverName: string, version: string) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: serverName, version },
  }
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
