export type FlowPackage = {
  format: 'backstory.flow.v1'
  flow: { name: string; description?: string; folder?: string; visibility?: 'shared' | 'private' | 'view'; graph: unknown }
}

export class BackstoryClient {
  constructor(private readonly options: { apiKey: string; baseUrl?: string }) {}
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.baseUrl ?? 'https://app.backstory.ai'}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!response.ok) throw new Error(`Backstory API ${response.status}: ${await response.text()}`)
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
  listFlows() { return this.request<{ data: unknown[] }>('/api/v1/flows') }
  getFlow(id: string) { return this.request<{ data: unknown; package: FlowPackage }>(`/api/v1/flows/${encodeURIComponent(id)}`) }
  importFlow(flow: FlowPackage) { return this.request<{ data: unknown }>('/api/v1/flows', { method: 'POST', body: JSON.stringify(flow) }) }
  updateFlow(id: string, flow: FlowPackage) { return this.request<{ data: unknown }>(`/api/v1/flows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(flow) }) }
  deleteFlow(id: string) { return this.request<void>(`/api/v1/flows/${encodeURIComponent(id)}`, { method: 'DELETE' }) }
  runFlow(id: string, input?: unknown) { return this.request<{ data: unknown }>(`/api/v1/flows/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ input }) }) }
}
