-- A personal template copy is its owner's own artifact: they may turn on a
-- view-only public link for it (and rotate or expire it), like any artifact.
-- Everything else about a copy stays locked, and a guest copy (no owner) is
-- locked whole — it is reachable only by its visitor's token.
CREATE OR REPLACE FUNCTION protect_artifact_template_configuration() RETURNS trigger AS $$
BEGIN
  IF OLD."templateSourceId" IS NOT NULL AND (
    ROW(NEW."templateSourceId", NEW."guestDigest", NEW."organizationId", NEW."userId", NEW."agentTaskId", NEW."flowId", NEW."assistantConfig", NEW."workspaceAccess", NEW."editorIds", NEW."shareTemplate", NEW."kind")
    IS DISTINCT FROM
    ROW(OLD."templateSourceId", OLD."guestDigest", OLD."organizationId", OLD."userId", OLD."agentTaskId", OLD."flowId", OLD."assistantConfig", OLD."workspaceAccess", OLD."editorIds", OLD."shareTemplate", OLD."kind")
    OR (OLD."userId" IS NULL AND
      ROW(NEW."shareAnonymous", NEW."shareTokenDigest", NEW."shareTokenCiphertext", NEW."shareExpiresAt")
      IS DISTINCT FROM
      ROW(OLD."shareAnonymous", OLD."shareTokenDigest", OLD."shareTokenCiphertext", OLD."shareExpiresAt"))
  ) THEN
    RAISE EXCEPTION 'Template copy configuration is locked';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
