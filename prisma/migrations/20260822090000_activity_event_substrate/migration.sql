-- Activity-event substrate (Sublime parity item 1): the storage foundation
-- for a normalized provider-activity event plane (Slack messages, Salesforce
-- record changes, GitHub events, ...) that flows can trigger on exactly once,
-- with cursor-checkpointed backfills. See
-- docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md.
--
-- Three tables:
--   activity_events         — normalized, persisted provider events (the
--                             ingestion target; @@unique(org, source,
--                             sourceEventId) makes duplicate deliveries acks).
--   activity_trigger_claims — exactly-once (event, flow) dispatch claim, the
--                             flow-side twin of AgentExecution.idempotencyKey.
--   activity_source_cursors — per-connection backfill checkpoint.
--
-- RLS + tenant_isolation policy + GRANTs ship in this same migration per the
-- house rule pinned by src/lib/__tests__/rls-coverage.db.test.ts: RLS enabled
-- without a policy is deny-all, and an org-scoped model whose table has RLS
-- disabled leaves PostgreSQL enforcing nothing while the tenant guard believes
-- it is protected (the flow_side_effects defect class; see
-- 20260818130000_rls_teams_grants_idps_tokens for the fuller writeup).

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorExternalId" TEXT,
    "ownerUserId" UUID,
    "visibility" TEXT NOT NULL DEFAULT 'org',
    "selfOrigin" BOOLEAN NOT NULL DEFAULT false,
    "backfill" BOOLEAN NOT NULL DEFAULT false,
    "chainDepth" INTEGER NOT NULL DEFAULT 0,
    "subject" JSONB,
    "payload" JSONB NOT NULL,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_source_cursors" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "cursor" JSONB NOT NULL,
    "lastBackfilledAt" TIMESTAMP(3),

    CONSTRAINT "activity_source_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_trigger_claims" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "activityEventId" UUID NOT NULL,
    "flowId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "flowRunId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_trigger_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_events_organizationId_indexedAt_idx" ON "activity_events"("organizationId", "indexedAt");

-- CreateIndex
CREATE INDEX "activity_events_organizationId_source_kind_createdAt_idx" ON "activity_events"("organizationId", "source", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "activity_events_organizationId_source_sourceEventId_key" ON "activity_events"("organizationId", "source", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_source_cursors_organizationId_source_connectionId_key" ON "activity_source_cursors"("organizationId", "source", "connectionId");

-- CreateIndex
CREATE INDEX "activity_trigger_claims_organizationId_flowId_createdAt_idx" ON "activity_trigger_claims"("organizationId", "flowId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "activity_trigger_claims_organizationId_activityEventId_flow_key" ON "activity_trigger_claims"("organizationId", "activityEventId", "flowId");

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_source_cursors" ADD CONSTRAINT "activity_source_cursors_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_trigger_claims" ADD CONSTRAINT "activity_trigger_claims_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: ENABLE + FORCE ROW LEVEL SECURITY, a tenant_isolation
-- policy scoping every row to app.organization_id (USING + WITH CHECK so
-- cross-tenant reads AND writes are both blocked), and GRANTs to the
-- RLS-constrained application role. Same shape as
-- 20260818130000_rls_teams_grants_idps_tokens.
DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['activity_events','activity_trigger_claims','activity_source_cursors'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', table_name);
    END IF;

    -- Server-only tables, same as the rest of the Prisma application schema.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$rls$;
