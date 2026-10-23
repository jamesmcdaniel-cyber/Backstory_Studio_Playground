-- Inbound BYOA: an external agent (running on someone else's infrastructure)
-- registered as a teammate. external_agents holds where its tasks go (an
-- SSRF-checked https webhook), the encrypted secret each delivery is signed
-- with, and the agents:reply API key it answers with. Its AgentTask row
-- (agentType 'EXTERNAL') is what the roster, Slack, flows and chat see.
--
-- agent_executions gains the per-task reply capability: a SHA-256 of a
-- single-use token (plaintext only ever in the signed webhook body) and its
-- expiry, which is also the run's reply deadline the dispatch tick enforces.
-- A tenant table under the standard RLS policy, like agent_action_ledger.

-- AlterTable
ALTER TABLE "agent_executions" ADD COLUMN     "replyTokenExpiresAt" TIMESTAMPTZ(6),
ADD COLUMN     "replyTokenHash" TEXT;

-- CreateTable
CREATE TABLE "external_agents" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentTaskId" TEXT NOT NULL,
    "webhookUrl" TEXT NOT NULL,
    "signingSecretCiphertext" TEXT NOT NULL,
    "signingSecretRotatedAt" TIMESTAMPTZ(6),
    "apiKeyId" TEXT,
    "capabilities" TEXT,
    "replyTimeoutMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastDeliveryAt" TIMESTAMPTZ(6),
    "lastDeliveryStatus" TEXT,
    "lastDeliveryError" TEXT,
    "lastReplyAt" TIMESTAMPTZ(6),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_agents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_agents_agentTaskId_key" ON "external_agents"("agentTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "external_agents_apiKeyId_key" ON "external_agents"("apiKeyId");

-- CreateIndex
CREATE INDEX "external_agents_organizationId_idx" ON "external_agents"("organizationId");

-- CreateIndex
CREATE INDEX "agent_executions_status_replyTokenExpiresAt_idx" ON "agent_executions"("status", "replyTokenExpiresAt");

-- AddForeignKey
ALTER TABLE "external_agents" ADD CONSTRAINT "external_agents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_agents" ADD CONSTRAINT "external_agents_agentTaskId_fkey" FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_agents" ADD CONSTRAINT "external_agents_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "external_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_agents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "external_agents" USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON "external_agents" TO backstory_app;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON "external_agents" FROM anon;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON "external_agents" FROM authenticated;
 END IF;
END $$;
