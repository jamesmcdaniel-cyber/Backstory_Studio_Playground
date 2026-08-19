-- Avatars ("teammates"): a named persona that owns a GROUP of agents.
--
-- The roster people manage is made of workers, not tasks. Installing a template
-- used to spawn a standalone agent; it now adds another job to an existing
-- teammate, so one avatar can run several agents doing different things.
--
-- Additive and backfill-free: agent_tasks."teammateId" is nullable, and a null
-- means exactly what every existing row already means — a solo agent with its
-- own card. ON DELETE SET NULL because removing an avatar must ungroup its
-- agents, never delete the work they do.

CREATE TABLE "agent_teammates" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "roleLabel"      TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "agent_teammates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_teammates_organizationId_idx" ON "agent_teammates"("organizationId");

ALTER TABLE "agent_teammates"
  ADD CONSTRAINT "agent_teammates_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_tasks" ADD COLUMN "teammateId" TEXT;

CREATE INDEX "agent_tasks_teammateId_idx" ON "agent_tasks"("teammateId");

ALTER TABLE "agent_tasks"
  ADD CONSTRAINT "agent_tasks_teammateId_fkey"
  FOREIGN KEY ("teammateId") REFERENCES "agent_teammates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. Enabling RLS
-- without a policy is deny-all in PostgreSQL, so the policy ships in the same
-- statement block as the enable — see 20260818130000 for the full rationale.
DO $rls$
BEGIN
  ALTER TABLE agent_teammates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE agent_teammates FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON agent_teammates;
  CREATE POLICY tenant_isolation ON agent_teammates
    USING ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organizationId" = nullif(current_setting('app.organization_id', true), '')::uuid);

  -- The RLS-constrained application role needs ordinary table privileges; the
  -- policy above is what limits those privileges to the active organization.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE agent_teammates TO backstory_app;
  END IF;

  -- Server-only, like the rest of the Prisma application schema.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE agent_teammates FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE agent_teammates FROM authenticated;
  END IF;
END
$rls$;
