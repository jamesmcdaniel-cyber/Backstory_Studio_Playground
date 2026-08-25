-- A review gate on publishing a flow.
--
-- Our approvals have always been RUNTIME gates: a running agent pauses before a
-- write. Nothing ever reviewed a flow DEFINITION before it went live — and a
-- published flow runs on a schedule, against real customer systems, with nobody
-- watching. We are careful about who IS an owner (the owner invariant is
-- enforced at four layers) and were casual about what an owner could ship
-- unreviewed.
--
-- Off by default. A two-person workspace does not want a second pair of eyes it
-- does not have, so this is a policy a workspace opts into rather than one
-- imposed on everyone.
--
-- The review stores a SNAPSHOT of the submitted draft, so a reviewer approves
-- what they actually read rather than whatever the author edited after asking.
-- Decided rows are kept: "who approved the change that broke this" is exactly
-- what an incident asks, and it is unanswerable from the flow row alone.
ALTER TABLE "organizations" ADD COLUMN "flowReviewRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "flow_reviews" (
  "id"             TEXT NOT NULL,
  "flowId"         TEXT NOT NULL,
  "organizationId" UUID NOT NULL,
  "graph"          JSONB NOT NULL,
  "summary"        JSONB,
  "note"           TEXT,
  "status"         TEXT NOT NULL DEFAULT 'open',
  "requestedBy"    TEXT NOT NULL,
  "requestedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedBy"      TEXT,
  "decidedAt"      TIMESTAMP(3),
  "decisionNote"   TEXT,
  CONSTRAINT "flow_reviews_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "flow_reviews_organizationId_status_requestedAt_idx"
  ON "flow_reviews" ("organizationId", "status", "requestedAt");
CREATE INDEX "flow_reviews_flowId_status_idx" ON "flow_reviews" ("flowId", "status");

-- One OPEN review per flow: asking the same question twice while it is pending
-- is how two reviewers approve two different drafts of the same change.
CREATE UNIQUE INDEX "flow_reviews_one_open_per_flow"
  ON "flow_reviews" ("flowId") WHERE "status" = 'open';

ALTER TABLE "flow_reviews" ADD CONSTRAINT "flow_reviews_flowId_fkey"
  FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_reviews" ADD CONSTRAINT "flow_reviews_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
