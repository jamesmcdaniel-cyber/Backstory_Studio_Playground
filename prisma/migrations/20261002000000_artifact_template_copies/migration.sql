ALTER TABLE "artifacts" ADD COLUMN "templateSourceId" TEXT,
  ADD COLUMN "shareTemplate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "agent_tasks" ADD COLUMN "artifactTemplateCopyId" TEXT;
CREATE UNIQUE INDEX "artifacts_organizationId_userId_templateSourceId_key"
  ON "artifacts"("organizationId", "userId", "templateSourceId");
CREATE UNIQUE INDEX "agent_tasks_artifactTemplateCopyId_key"
  ON "agent_tasks"("artifactTemplateCopyId");

-- Enforce configuration immutability even on alternate writers (MCP, jobs).
-- Content/version/chat/state changes remain available to the copy's copilot.
CREATE FUNCTION protect_artifact_template_configuration() RETURNS trigger AS $$
BEGIN
  IF OLD."templateSourceId" IS NOT NULL AND
    ROW(NEW."templateSourceId", NEW."organizationId", NEW."userId", NEW."agentTaskId", NEW."flowId", NEW."assistantConfig", NEW."workspaceAccess", NEW."editorIds", NEW."shareAnonymous", NEW."shareTemplate", NEW."shareTokenDigest", NEW."shareTokenCiphertext", NEW."kind")
    IS DISTINCT FROM
    ROW(OLD."templateSourceId", OLD."organizationId", OLD."userId", OLD."agentTaskId", OLD."flowId", OLD."assistantConfig", OLD."workspaceAccess", OLD."editorIds", OLD."shareAnonymous", OLD."shareTemplate", OLD."shareTokenDigest", OLD."shareTokenCiphertext", OLD."kind") THEN
    RAISE EXCEPTION 'Template copy configuration is locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER artifact_template_configuration_lock BEFORE UPDATE ON "artifacts"
  FOR EACH ROW EXECUTE FUNCTION protect_artifact_template_configuration();

CREATE FUNCTION protect_artifact_template_agent() RETURNS trigger AS $$
BEGIN
  IF OLD."artifactTemplateCopyId" IS NOT NULL AND
    ROW(NEW."artifactTemplateCopyId", NEW."organizationId", NEW."objective", NEW."context", NEW."schedule", NEW."visibility", NEW."metadata", NEW."publishedConfig", NEW."goal")
    IS DISTINCT FROM
    ROW(OLD."artifactTemplateCopyId", OLD."organizationId", OLD."objective", OLD."context", OLD."schedule", OLD."visibility", OLD."metadata", OLD."publishedConfig", OLD."goal") THEN
    RAISE EXCEPTION 'Template copilot configuration is locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER artifact_template_agent_lock BEFORE UPDATE ON "agent_tasks"
  FOR EACH ROW EXECUTE FUNCTION protect_artifact_template_agent();
