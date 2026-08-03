export class BackstoryClient {
    options;
    constructor(options) {
        this.options = options;
    }
    async request(path, init) {
        const response = await fetch(`${this.options.baseUrl ?? 'https://app.backstory.ai'}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', ...init?.headers },
        });
        if (!response.ok)
            throw new Error(`Backstory API ${response.status}: ${await response.text()}`);
        if (response.status === 204)
            return undefined;
        return response.json();
    }
    listFlows() { return this.request('/api/v1/flows'); }
    getFlow(id) { return this.request(`/api/v1/flows/${encodeURIComponent(id)}`); }
    importFlow(flow) { return this.request('/api/v1/flows', { method: 'POST', body: JSON.stringify(flow) }); }
    updateFlow(id, flow) { return this.request(`/api/v1/flows/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(flow) }); }
    deleteFlow(id) { return this.request(`/api/v1/flows/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    runFlow(id, input) { return this.request(`/api/v1/flows/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ input }) }); }
}
