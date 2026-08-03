-- AlterTable
ALTER TABLE "agent_executions" ADD COLUMN     "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "flow_runs" ADD COLUMN     "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentExecutionId" TEXT,
    "flowRunId" TEXT,
    "flowRunStepId" TEXT,
    "surface" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "priceVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_calls_organizationId_createdAt_idx" ON "llm_calls"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "llm_calls_flowRunId_idx" ON "llm_calls"("flowRunId");
