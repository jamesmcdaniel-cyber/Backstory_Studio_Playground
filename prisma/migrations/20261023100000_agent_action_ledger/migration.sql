-- The action ledger: one row per side-effecting tool call an agent or flow
-- made, with a redacted argument summary, the provider's reference to what it
-- created, and (for cheaply-readable updates) the prior values Undo restores.
-- A tenant row under the standard RLS policy, like artifact_render_errors.

-- CreateTable
CREATE TABLE "agent_action_ledger" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "agentTaskId" TEXT,
    "flowId" TEXT,
    "runId" TEXT NOT NULL,
    "stepRef" TEXT,
    "approvalId" TEXT,
    "approvedById" TEXT,
    "actorUserId" TEXT,
    "provider" TEXT NOT NULL,
    "plane" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "connectionRef" JSONB,
    "argsSummary" JSONB NOT NULL DEFAULT '{}',
    "resultRef" JSONB,
    "beforeImage" JSONB,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "undoneAt" TIMESTAMPTZ(6),
    "undoneById" TEXT,
    "undoError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_action_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_action_ledger_organizationId_agentTaskId_createdAt_idx" ON "agent_action_ledger"("organizationId", "agentTaskId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_action_ledger_organizationId_flowId_createdAt_idx" ON "agent_action_ledger"("organizationId", "flowId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_action_ledger_organizationId_runId_idx" ON "agent_action_ledger"("organizationId", "runId");

-- AddForeignKey
ALTER TABLE "agent_action_ledger" ADD CONSTRAINT "agent_action_ledger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_action_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_action_ledger" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_action_ledger" USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_action_ledger" TO backstory_app;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "agent_action_ledger" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "agent_action_ledger" FROM authenticated;
 END IF;
END $$;
