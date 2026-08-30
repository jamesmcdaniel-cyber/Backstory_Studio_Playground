-- Conversations with the help assistant, held server-side.
--
-- The widget kept them in sessionStorage: one tab, six turns, gone on close,
-- and replayed back into the prompt by the client. These tables are what let a
-- thread be read back later, what let "clear" delete rows everywhere instead of
-- emptying one React array, and what let the route take replayed turns from the
-- database rather than from whatever the caller claims was said.
--
-- Mirrors agent_chat_sessions / agent_chat_messages, with two departures: no
-- Slack thread columns, since this assistant only exists in-app, and a NOT NULL
-- "sessionId" — nullable on agent chat only because that feature predates its
-- own sessions.

CREATE TABLE "librarian_chat_sessions" (
    "id"             TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId"         TEXT NOT NULL,
    "title"          TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "librarian_chat_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "librarian_chat_messages" (
    "id"             TEXT NOT NULL,
    "sessionId"      TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId"         TEXT NOT NULL,
    "role"           TEXT NOT NULL,
    "content"        TEXT NOT NULL,
    -- Cards and citations shown under an assistant turn, so a restored thread
    -- renders as it did live rather than as bare text.
    "metadata"       JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "librarian_chat_messages_pkey" PRIMARY KEY ("id")
);

-- The history list's only read: this caller's own threads, newest first. Both
-- scoping columns lead, because neither is ever queried without the other.
CREATE INDEX "librarian_chat_sessions_organizationId_userId_updatedAt_idx"
  ON "librarian_chat_sessions"("organizationId", "userId", "updatedAt");
-- And a restored thread's: its turns in the order they were said.
CREATE INDEX "librarian_chat_messages_sessionId_createdAt_idx"
  ON "librarian_chat_messages"("sessionId", "createdAt");

-- Cascade, so deleting a thread takes its turns with it. "Clear" promises the
-- rows are gone; an orphaned message table would make that promise false.
ALTER TABLE "librarian_chat_messages"
  ADD CONSTRAINT "librarian_chat_messages_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "librarian_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- And the same promise one level up. Workspace teardown is a single
-- organization.delete(); a thread with no foreign key to hang off would outlive
-- the workspace it quotes rather than being deleted with it.
ALTER TABLE "librarian_chat_sessions"
  ADD CONSTRAINT "librarian_chat_sessions_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. The routes
-- already scope every query by organizationId + userId; this makes the database
-- enforce the org half, so a direct-SQL mistake fails closed instead of
-- returning another workspace's conversations.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['librarian_chat_sessions', 'librarian_chat_messages'] LOOP
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
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$rls$;
