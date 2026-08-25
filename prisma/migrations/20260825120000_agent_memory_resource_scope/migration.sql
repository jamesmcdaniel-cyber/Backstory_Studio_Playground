-- Agent memory, filed under the thing it is about.
--
-- Memory was keyed by agent alone. For a sales platform that makes the most
-- common question unanswerable: "what have we learned about Acme" is a
-- per-account question, and every learning sat under whichever agent happened
-- to acquire it. `resourceId` is that scope — an account id, a CRM record id,
-- an opportunity — and NULL keeps its existing meaning: the agent knows this
-- generally, not about any one record. Recall reads BOTH, so scoping narrows
-- without hiding what the agent knows in general.
--
-- `contentHash` closes a second hole. Deduplication only ever covered
-- suggestions, and only when embeddings were configured; two runs recording the
-- same learning in a keyword-only deployment produced two rows forever. The
-- unique index makes the same title+content, for the same agent and resource, a
-- single row.
--
-- No backfill. Existing rows keep resourceId NULL (correct: they were never
-- about a particular record) and contentHash NULL. NULLs do not collide in a
-- Postgres unique index, so the constraint is inert for every existing row and
-- binds only what is written from here on.
ALTER TABLE "agent_memories" ADD COLUMN "resourceId" TEXT;
ALTER TABLE "agent_memories" ADD COLUMN "contentHash" TEXT;

CREATE INDEX "agent_memories_organizationId_agentId_resourceId_status_idx"
  ON "agent_memories" ("organizationId", "agentId", "resourceId", "status");

CREATE UNIQUE INDEX "agent_memories_content_dedup"
  ON "agent_memories" ("organizationId", "agentId", "resourceId", "contentHash");
