-- CreateTable
CREATE TABLE "public"."huddle_segments" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "speakerName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "huddle_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."huddle_notes" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "sessionId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "decisions" JSONB NOT NULL DEFAULT '[]',
    "participants" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "huddle_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "huddle_segments_sessionId_startedAt_idx" ON "public"."huddle_segments"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "huddle_segments_createdAt_idx" ON "public"."huddle_segments"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "huddle_notes_sessionId_key" ON "public"."huddle_notes"("sessionId");

-- CreateIndex
CREATE INDEX "huddle_notes_flowId_createdAt_idx" ON "public"."huddle_notes"("flowId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."huddle_segments" ADD CONSTRAINT "huddle_segments_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "public"."flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."huddle_segments" ADD CONSTRAINT "huddle_segments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."huddle_notes" ADD CONSTRAINT "huddle_notes_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "public"."flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."huddle_notes" ADD CONSTRAINT "huddle_notes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

