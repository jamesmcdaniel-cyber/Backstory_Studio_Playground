export type FlowPackage = {
    format: 'backstory.flow.v1';
    flow: {
        name: string;
        description?: string;
        folder?: string;
        visibility?: 'shared' | 'private' | 'view';
        graph: unknown;
    };
};
export declare class BackstoryClient {
    private readonly options;
    constructor(options: {
        apiKey: string;
        baseUrl?: string;
    });
    private request;
    listFlows(): Promise<{
        data: unknown[];
    }>;
    getFlow(id: string): Promise<{
        data: unknown;
        package: FlowPackage;
    }>;
    importFlow(flow: FlowPackage): Promise<{
        data: unknown;
    }>;
    updateFlow(id: string, flow: FlowPackage): Promise<{
        data: unknown;
    }>;
    deleteFlow(id: string): Promise<void>;
    runFlow(id: string, input?: unknown): Promise<{
        data: unknown;
    }>;
}
