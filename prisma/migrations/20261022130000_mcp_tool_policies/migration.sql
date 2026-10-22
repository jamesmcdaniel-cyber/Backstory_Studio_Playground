-- Per-tool permissions on an MCP connection: toolName -> 'approve' | 'off'.
-- Absent means allowed, so every existing connection keeps every tool.
ALTER TABLE "mcp_connections" ADD COLUMN "toolPolicies" JSONB NOT NULL DEFAULT '{}';
