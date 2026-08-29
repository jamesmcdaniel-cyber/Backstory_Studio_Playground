-- Slash commands: which teammate a workspace's `/dealcheck` reaches.
--
-- `command` is stored without its leading slash and lowercased (see the model's
-- doc comment) so the binding does not depend on the casing the workspace
-- happened to type into the Slack app config.

CREATE TABLE "slack_command_bindings" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "command"        TEXT NOT NULL,
  "agentTaskId"    TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "slack_command_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_command_bindings_organizationId_command_key"
  ON "slack_command_bindings"("organizationId", "command");
CREATE INDEX "slack_command_bindings_agentTaskId_idx" ON "slack_command_bindings"("agentTaskId");

ALTER TABLE "slack_command_bindings"
  ADD CONSTRAINT "slack_command_bindings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_command_bindings"
  ADD CONSTRAINT "slack_command_bindings_agentTaskId_fkey"
  FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table.
DO $rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['slack_command_bindings'] LOOP
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
