-- The only data a shared-artifact copilot may query is an MCP server its owner
-- has explicitly marked shareable (demo data). Off for every existing server.
ALTER TABLE "mcp_connections" ADD COLUMN "shareableWithCopilots" BOOLEAN NOT NULL DEFAULT false;
