import type { WorkflowGraph } from './workflow.js'

export type BackstoryClientOptions = { baseUrl: string; apiKey: string; fetch?: typeof globalThis.fetch }
export type FlowSummary = { id: string; name: string; description?: string; status: string; version: number; updatedAt: string }
export type FlowRun = { flowRunId: string; status: string; output?: unknown; error?: string | null }
export type NativeFlowPackage = {
  format: 'backstory.flow.v1'
  flow: {
    name: string
    description?: string
    folder?: string
    visibility?: 'shared' | 'private' | 'view'
    graph: WorkflowGraph
  }
}

export class BackstoryApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'BackstoryApiError'
  }
}

export class BackstoryClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly fetcher: typeof globalThis.fetch

  constructor(options: BackstoryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.fetcher = options.fetch ?? globalThis.fetch
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error('baseUrl must be an absolute HTTP(S) URL.')
    if (!this.apiKey.trim()) throw new Error('apiKey is required.')
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: { accept: 'application/json', authorization: `Bearer ${this.apiKey}`, ...init.headers },
    })
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } }
    if (!response.ok) throw new BackstoryApiError(body.error?.message ?? `Backstory returned HTTP ${response.status}.`, response.status, body.error?.code)
    return body as T
  }

  async listFlows(): Promise<FlowSummary[]> {
    const result = await this.request<{ data?: FlowSummary[]; flows?: FlowSummary[] }>('/api/v1/flows')
    return result.data ?? result.flows ?? []
  }

  getFlow(flowId: string): Promise<Record<string, unknown>> {
    return this.request<{ data: Record<string, unknown> }>(`/api/v1/flows/${encodeURIComponent(flowId)}`).then((result) => result.data)
  }

  createFlow(flow: NativeFlowPackage['flow']): Promise<Record<string, unknown>> {
    return this.request<{ data: Record<string, unknown> }>('/api/v1/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'backstory.flow.v1', flow }),
    }).then((result) => result.data)
  }

  updateFlow(flowId: string, flow: NativeFlowPackage['flow']): Promise<Record<string, unknown>> {
    return this.request<{ data: Record<string, unknown> }>(`/api/v1/flows/${encodeURIComponent(flowId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'backstory.flow.v1', flow }),
    }).then((result) => result.data)
  }

  async deleteFlow(flowId: string): Promise<void> {
    await this.request<void>(`/api/v1/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE' })
  }

  runFlow(flowId: string, input?: unknown): Promise<FlowRun> {
    return this.request<{ data: FlowRun }>(`/api/v1/flows/${encodeURIComponent(flowId)}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }).then((result) => result.data)
  }

  async callMcpTool<TResult = unknown>(name: string, args: Record<string, unknown> = {}): Promise<TResult> {
    const result = await this.request<{
      result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      error?: { code?: number; message?: string }
    }>('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    if (result.error) throw new BackstoryApiError(result.error.message ?? 'MCP request failed.', 200, String(result.error.code ?? 'MCP_ERROR'))
    const text = result.result?.content?.find((item) => item.type === 'text')?.text
    if (result.result?.isError) throw new BackstoryApiError(text ?? 'MCP tool call failed.', 200, 'MCP_TOOL_ERROR')
    if (!text) return result.result as TResult
    try { return JSON.parse(text) as TResult }
    catch { return text as TResult }
  }
}
