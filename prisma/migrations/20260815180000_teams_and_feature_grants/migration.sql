-- Teams, and feature entitlements granted at workspace / team / user scope.
--
-- A PERMISSION says what authority someone has and is the same for every
-- workspace. A FEATURE says what has been switched on for them, varies per
-- customer, and changes without anyone's authority changing. Modelling
-- features as permissions would mean inventing a role per combination of
-- purchased features, which is how role systems become unmaintainable.
--
-- Three grant scopes because that is how the request arrives: pilots go to a
-- team, exceptions go to a person, the plan goes to the workspace.
--
-- `enabled = false` is an explicit DENY that beats any grant. Without it the
-- only way to exclude one person from a workspace-wide feature is to stop
-- granting it to everyone.

CREATE TABLE "teams" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT NOT NULL DEFAULT '',
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "teams_organizationId_name_key" ON "teams"("organizationId", "name");
CREATE INDEX "teams_organizationId_idx" ON "teams"("organizationId");
ALTER TABLE "teams" ADD CONSTRAINT "teams_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "team_members" (
  "id"        TEXT NOT NULL,
  "teamId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  -- Team-local standing only. A team lead is NOT a workspace admin; keeping
  -- the two separate is what stops team membership becoming a back door to
  -- authority.
  "teamRole"  TEXT NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "team_members_teamId_userId_key" ON "team_members"("teamId", "userId");
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feature_grants" (
  "id"             TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "feature"        TEXT NOT NULL,
  "teamId"         TEXT,
  "userId"         TEXT,
  "enabled"        BOOLEAN NOT NULL DEFAULT true,
  "reason"         TEXT NOT NULL DEFAULT '',
  "grantedById"    TEXT,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "feature_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feature_grants_organizationId_feature_teamId_userId_key"
  ON "feature_grants"("organizationId", "feature", "teamId", "userId");
CREATE INDEX "feature_grants_organizationId_feature_idx" ON "feature_grants"("organizationId", "feature");
CREATE INDEX "feature_grants_userId_idx" ON "feature_grants"("userId");
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feature_grants" ADD CONSTRAINT "feature_grants_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
