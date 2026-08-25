-- Draft and published, for agents.
--
-- Editing an agent edited the LIVE agent: a tweak to an objective changed what
-- the next scheduled run did, immediately, with no staging and no review.
-- Flows have had a draft/publishedGraph split since the beginning, and agents
-- are the ones that act through a person's own accounts and write to real
-- systems — the asymmetry was always the harder one to defend.
--
-- `publishedConfig` holds the definition a run uses: the task fields plus the
-- connector keys that were bound when it was published, so publishing pins the
-- TOOLS as well as the words. NULL means unpublished, which is every agent that
-- exists today, and those keep behaving exactly as they do now: the live fields
-- are read directly and nothing about their runs changes.
ALTER TABLE "agent_tasks" ADD COLUMN "publishedConfig" JSONB;
ALTER TABLE "agent_tasks" ADD COLUMN "publishedAt" TIMESTAMPTZ(6);
