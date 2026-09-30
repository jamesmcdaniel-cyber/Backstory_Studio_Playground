-- The artifact assistant's settings: standing instructions and the extra
-- connected tools it may use.
ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "assistantConfig" JSONB;
