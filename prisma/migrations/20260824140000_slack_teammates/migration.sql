-- Slack teammates: who a Slack user is, which teammate a channel reaches, and
-- which thread a conversation belongs to.

ALTER TABLE "agent_chat_sessions" ADD COLUMN "slackChannelId" TEXT;
ALTER TABLE "agent_chat_sessions" ADD COLUMN "slackThreadTs" TEXT;

-- Plain, NOT partial, so it matches the schema's @@unique exactly -- a partial
-- index here would read as permanent drift to `prisma migrate diff`. It is
-- still safe for the millions of in-app sessions that leave both columns null:
-- Postgres treats NULLs as distinct in a unique index, so any number of
-- all-null rows coexist.
CREATE UNIQUE INDEX "agent_chat_sessions_slackChannelId_slackThreadTs_key"
  ON "agent_chat_sessions"("slackChannelId", "slackThreadTs");

CREATE TABLE "slack_identities" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "slackUserId"    TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "verifiedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "slack_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_identities_organizationId_slackUserId_key"
  ON "slack_identities"("organizationId", "slackUserId");
CREATE INDEX "slack_identities_userId_idx" ON "slack_identities"("userId");

ALTER TABLE "slack_identities"
  ADD CONSTRAINT "slack_identities_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_identities"
  ADD CONSTRAINT "slack_identities_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "slack_channel_bindings" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "channelId"      TEXT NOT NULL,
  "agentTaskId"    TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "slack_channel_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_channel_bindings_organizationId_channelId_key"
  ON "slack_channel_bindings"("organizationId", "channelId");
CREATE INDEX "slack_channel_bindings_agentTaskId_idx" ON "slack_channel_bindings"("agentTaskId");

ALTER TABLE "slack_channel_bindings"
  ADD CONSTRAINT "slack_channel_bindings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_channel_bindings"
  ADD CONSTRAINT "slack_channel_bindings_agentTaskId_fkey"
  FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. Enabling RLS
-- without a policy is deny-all in PostgreSQL, so the policy ships in the same
-- statement block as the enable -- see 20260818130000 for the full rationale.
DO $rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['slack_identities', 'slack_channel_bindings'] LOOP
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
