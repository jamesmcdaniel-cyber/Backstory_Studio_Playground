-- Per-workspace AI egress policy.
--
-- 'blocked' refuses every model call for the workspace: the enforceable switch
-- for customers whose data-processing agreement forbids sending content to a
-- model provider. Enforcement that REFUSES is honest in a way masking is not —
-- a masking layer either breaks the sales work this product exists for or
-- grows an allowlist until it protects nothing while claiming to.
ALTER TABLE "organizations" ADD COLUMN "aiEgressPolicy" TEXT NOT NULL DEFAULT 'allowed';
