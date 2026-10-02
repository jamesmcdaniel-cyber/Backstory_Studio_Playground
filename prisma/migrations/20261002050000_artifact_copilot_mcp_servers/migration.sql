-- MCP servers the person using a shared-template copy connected for its
-- copilot, with their own (encrypted) credentials. Its own column, outside the
-- copy's locked configuration (protect_artifact_template_configuration keeps
-- "assistantConfig" immutable on a copy), and never a row among the host
-- workspace's mcp_connections.
ALTER TABLE "artifacts" ADD COLUMN "copilotMcpServers" JSONB;
