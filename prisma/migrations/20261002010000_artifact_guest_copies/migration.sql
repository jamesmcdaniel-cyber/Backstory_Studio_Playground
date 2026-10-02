-- Guest copies: an anonymous visitor's copy of a public template, held in the
-- sharer's workspace with no owner and opened only by the visitor's token.
ALTER TABLE "artifacts" ADD COLUMN "guestDigest" TEXT;
CREATE UNIQUE INDEX "artifacts_templateSourceId_guestDigest_key"
  ON "artifacts"("templateSourceId", "guestDigest");

-- The visitor binding is part of a copy's locked configuration.
CREATE OR REPLACE FUNCTION protect_artifact_template_configuration() RETURNS trigger AS $$
BEGIN
  IF OLD."templateSourceId" IS NOT NULL AND
    ROW(NEW."templateSourceId", NEW."guestDigest", NEW."organizationId", NEW."userId", NEW."agentTaskId", NEW."flowId", NEW."assistantConfig", NEW."workspaceAccess", NEW."editorIds", NEW."shareAnonymous", NEW."shareTemplate", NEW."shareTokenDigest", NEW."shareTokenCiphertext", NEW."kind")
    IS DISTINCT FROM
    ROW(OLD."templateSourceId", OLD."guestDigest", OLD."organizationId", OLD."userId", OLD."agentTaskId", OLD."flowId", OLD."assistantConfig", OLD."workspaceAccess", OLD."editorIds", OLD."shareAnonymous", OLD."shareTemplate", OLD."shareTokenDigest", OLD."shareTokenCiphertext", OLD."kind") THEN
    RAISE EXCEPTION 'Template copy configuration is locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
