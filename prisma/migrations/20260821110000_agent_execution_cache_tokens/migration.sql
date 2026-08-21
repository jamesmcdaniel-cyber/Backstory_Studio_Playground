-- Split AgentExecution.inputTokens into fresh-input + cache-write + cache-read
-- buckets, mirroring LlmCall. Existing rows keep their (folded) inputTokens
-- value and default the two new columns to 0 -- a re-labeling, not a data
-- loss: inputTokens + cacheWriteTokens + cacheReadTokens is the same total
-- before and after for any given row.
ALTER TABLE "agent_executions" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_executions" ADD COLUMN "cacheReadTokens" INTEGER NOT NULL DEFAULT 0;
