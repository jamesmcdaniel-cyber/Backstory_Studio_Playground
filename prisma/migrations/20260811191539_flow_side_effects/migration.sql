-- CreateTable
CREATE TABLE "flow_side_effects" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "iterationKey" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 0,
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flowRunId" TEXT,

    CONSTRAINT "flow_side_effects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "flow_side_effects_organizationId_createdAt_idx" ON "flow_side_effects"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "flow_side_effects_scopeKey_iterationKey_page_key" ON "flow_side_effects"("scopeKey", "iterationKey", "page");

-- AddForeignKey
ALTER TABLE "flow_side_effects" ADD CONSTRAINT "flow_side_effects_flowRunId_fkey" FOREIGN KEY ("flowRunId") REFERENCES "flow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
