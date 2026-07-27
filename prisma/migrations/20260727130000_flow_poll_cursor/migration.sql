-- Polling trigger: dedupe cursor of already-emitted item keys ({ seen: string[] }).
ALTER TABLE "flows" ADD COLUMN "pollCursor" JSONB;
