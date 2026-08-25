ALTER TABLE "flow_run_steps" ADD COLUMN "items" JSONB;
ALTER TABLE "flows" ADD COLUMN "settings" JSONB NOT NULL DEFAULT '{}';
