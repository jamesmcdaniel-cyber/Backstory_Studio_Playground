-- Adoption rollups: durable weekly aggregates that outlive the execution prune.
--
-- /api/cron/retention deletes AgentExecution at RETENTION_DAYS (default 90),
-- so cohort survival past a quarter is not merely expensive to compute live --
-- it is impossible, because the rows are gone. These tables are written ahead
-- of the prune and hold counts only: no user ids, no inputs, no outputs. That
-- is what makes outliving the retention window legitimate rather than a leak.

-- Soft deletion carried no timestamp, and updatedAt moves on every edit, so
-- "agents deleted this week" was not computable. Rows deleted before this
-- column stay null rather than being guessed from updatedAt.
ALTER TABLE "agent_tasks" ADD COLUMN "deletedAt" TIMESTAMPTZ(6);

CREATE TABLE "adoption_weeks" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId"          UUID NOT NULL,
  "weekStart"               DATE NOT NULL,
  "agentsCreated"           INTEGER NOT NULL DEFAULT 0,
  "agentsDeleted"           INTEGER NOT NULL DEFAULT 0,
  "execTotal"               INTEGER NOT NULL DEFAULT 0,
  "execManual"              INTEGER NOT NULL DEFAULT 0,
  "execByTrigger"           JSONB NOT NULL DEFAULT '{}',
  "engagedUsers"            INTEGER NOT NULL DEFAULT 0,
  "approvalsApproved"       INTEGER NOT NULL DEFAULT 0,
  "approvalsRejected"       INTEGER NOT NULL DEFAULT 0,
  "approvalsOther"          INTEGER NOT NULL DEFAULT 0,
  "approvalLatencyMedianMs" INTEGER,
  "computedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "adoption_weeks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "adoption_weeks_organizationId_weekStart_key"
  ON "adoption_weeks"("organizationId", "weekStart");
CREATE INDEX "adoption_weeks_weekStart_idx" ON "adoption_weeks"("weekStart");

ALTER TABLE "adoption_weeks"
  ADD CONSTRAINT "adoption_weeks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "agent_cohort_weeks" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "agentTaskId"    TEXT NOT NULL,
  "cohortWeek"     DATE NOT NULL,
  "activeWeek"     DATE NOT NULL,

  CONSTRAINT "agent_cohort_weeks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_cohort_weeks_agentTaskId_activeWeek_key"
  ON "agent_cohort_weeks"("agentTaskId", "activeWeek");
CREATE INDEX "agent_cohort_weeks_organizationId_cohortWeek_idx"
  ON "agent_cohort_weeks"("organizationId", "cohortWeek");
CREATE INDEX "agent_cohort_weeks_cohortWeek_activeWeek_idx"
  ON "agent_cohort_weeks"("cohortWeek", "activeWeek");

-- Intentionally NO foreign key from "agentTaskId" to "agent_tasks". See the
-- model doc-comment: cascade-deleting an abandoned agent's history would erase
-- the exact evidence this table exists to keep.
ALTER TABLE "agent_cohort_weeks"
  ADD CONSTRAINT "agent_cohort_weeks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. Enabling RLS
-- without a policy is deny-all in PostgreSQL, so the policy ships in the same
-- statement block as the enable -- see 20260818130000 for the full rationale.
DO $rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['adoption_weeks', 'agent_cohort_weeks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)
         WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END
$rls$;
