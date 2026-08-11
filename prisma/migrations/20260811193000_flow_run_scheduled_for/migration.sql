-- AlterTable
ALTER TABLE "flow_runs" ADD COLUMN     "scheduledFor" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "flow_runs_flowId_scheduledFor_key" ON "flow_runs"("flowId", "scheduledFor");

