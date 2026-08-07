-- Platform owner protection.
--
-- The OWNER role is the platform root tier and is reserved for the two
-- platform owner identities (src/lib/authz/platform-owner.ts):
--   james.mcdaniel@people.ai, james.mcdaniel@backstory.ai
--
-- Application layers refuse owner-touching writes with friendly errors; this
-- trigger is the final, client-independent backstop. It guarantees:
--   1. Owner rows can never be deleted (including FK cascades) or deactivated.
--   2. An owner's role can never leave OWNER, and their email is immutable.
--   3. No other row can hold OWNER, and no existing row can take an owner
--      email (which would inherit owner permissions by identity).

-- Backfill: OWNER was previously an org-level tier; reserve it for the
-- platform owner and settle everyone else on ADMIN (its former equivalent).
UPDATE "users" SET "role" = 'ADMIN'
WHERE "role" = 'OWNER'
  AND ("email" IS NULL OR lower("email") NOT IN ('james.mcdaniel@people.ai', 'james.mcdaniel@backstory.ai'));

UPDATE "users" SET "role" = 'OWNER', "isActive" = true
WHERE "email" IS NOT NULL
  AND lower("email") IN ('james.mcdaniel@people.ai', 'james.mcdaniel@backstory.ai');

CREATE OR REPLACE FUNCTION protect_platform_owner() RETURNS trigger AS $$
DECLARE
  owner_emails CONSTANT text[] := ARRAY['james.mcdaniel@people.ai', 'james.mcdaniel@backstory.ai'];
  old_is_owner boolean := false;
  new_is_owner boolean := false;
BEGIN
  -- OLD/NEW are unassigned on INSERT/DELETE respectively; only touch them
  -- inside the applicable branch.
  IF TG_OP <> 'INSERT' THEN
    old_is_owner := OLD."email" IS NOT NULL AND lower(OLD."email") = ANY (owner_emails);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_is_owner := NEW."email" IS NOT NULL AND lower(NEW."email") = ANY (owner_emails);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF old_is_owner THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the platform owner account cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND old_is_owner THEN
    IF NEW."email" IS DISTINCT FROM OLD."email" THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the platform owner email cannot be changed';
    END IF;
    IF NEW."role"::text <> 'OWNER' THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the platform owner role cannot be changed';
    END IF;
    IF NEW."isActive" = false THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the platform owner cannot be deactivated';
    END IF;
    RETURN NEW;
  END IF;

  -- Non-owner rows: OWNER is not grantable, and an existing row may not take
  -- an owner email (permissions resolve by identity, so that would be a grant).
  IF TG_OP = 'UPDATE' AND new_is_owner THEN
    RAISE EXCEPTION 'OWNER_RESERVED: this email is reserved for the platform owner';
  END IF;
  IF NEW."role"::text = 'OWNER' AND NOT new_is_owner THEN
    RAISE EXCEPTION 'OWNER_RESERVED: the OWNER role is reserved for the platform owner';
  END IF;

  -- Provisioning an owner identity self-heals to the root tier.
  IF TG_OP = 'INSERT' AND new_is_owner THEN
    NEW."role" := 'OWNER';
    NEW."isActive" := true;
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_platform_owner ON "users";
CREATE TRIGGER protect_platform_owner
  BEFORE INSERT OR UPDATE OR DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION protect_platform_owner();
