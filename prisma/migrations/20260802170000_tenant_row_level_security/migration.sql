-- Defense-in-depth tenant isolation. Production must use a non-BYPASSRLS role
-- in DATABASE_URL and a separate migration/system role in SYSTEM_DATABASE_URL.
-- SET LOCAL app.organization_id is applied by src/lib/prisma.ts.
DO $rls$
DECLARE
  table_name text;
  tenant_tables text[] := ARRAY[
    'invitations','organization_domains','scim_tokens','api_keys',
    'agent_tasks','agent_connectors','agent_memories','agent_chat_messages','agent_chat_sessions',
    'signals','signal_subscriptions','custom_signals','agent_executions','notifications',
    'push_subscriptions','audit_events','approval_requests','agent_templates','integrations',
    'people_ai_connections','mcp_connections','nango_connections','integration_secrets','http_credentials',
    'flows','flow_templates','flow_template_versions','flow_versions','flow_runs',
    'huddle_segments','huddle_notes','knowledge_documents','knowledge_chunks','shared_skills',
    'template_proposals','stored_files','catalogue_submissions','flow_webhook_receipts','outbox_events'
  ];
BEGIN
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END
$rls$;

-- Tables whose tenant ownership is carried by a required parent relation.
ALTER TABLE flow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_run_steps
  USING (EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = "flowRunId" AND r."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = "flowRunId" AND r."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid));

ALTER TABLE flow_collaborators ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_collaborators FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_collaborators
  USING (EXISTS (SELECT 1 FROM flows f WHERE f.id = "flowId" AND f."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid))
  WITH CHECK (EXISTS (SELECT 1 FROM flows f WHERE f.id = "flowId" AND f."organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid));

DO $children$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['execution_messages','workflow_steps','workflow_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (EXISTS (SELECT 1 FROM agent_executions e WHERE e.id = "executionId" AND e."organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)) WITH CHECK (EXISTS (SELECT 1 FROM agent_executions e WHERE e.id = "executionId" AND e."organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid))',
      table_name
    );
  END LOOP;
END
$children$;
