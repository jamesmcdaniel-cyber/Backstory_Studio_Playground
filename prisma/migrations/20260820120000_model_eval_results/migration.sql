-- Graded model evaluations: bench fixtures and shadow comparisons, per model.
-- Scores and token counts only — shadow rows are graded on tenant prompts, so
-- text (including judge reasoning) is never stored for them.
CREATE TABLE "model_eval_results" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "score" DECIMAL(4,3),
    "pass" BOOLEAN,
    "reasoning" TEXT,
    "judgeModel" TEXT,
    "pairId" TEXT,
    "champion" BOOLEAN,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "organizationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_eval_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "model_eval_results_kind_model_createdAt_idx" ON "model_eval_results"("kind", "model", "createdAt");
CREATE INDEX "model_eval_results_pairId_idx" ON "model_eval_results"("pairId");
