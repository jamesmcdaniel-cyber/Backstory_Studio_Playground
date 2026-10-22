-- A flow's public (no sign-in, view-only) link gets its own token.
--
-- Until now "Anyone, no sign-in" reused the cross-workspace share token
-- (shareTokenDigest) with shareAnonymous = true. That token is also what
-- `?share=<token>` presents to resolveFlowRole, so anyone who signed in with a
-- link meant to be posted publicly joined the flow as a view collaborator —
-- the full graph, run history and the right to run it, not the sanitized page.
--
-- The public link now has a separate 192-bit token, stored as a SHA-256 digest
-- (lookup) and encrypted (so an editor can copy it again), an optional expiry,
-- and a second opt-in for "Use this flow" copies.

ALTER TABLE "public"."flows" ADD COLUMN "publicTokenDigest" TEXT;
ALTER TABLE "public"."flows" ADD COLUMN "publicTokenCiphertext" TEXT;
ALTER TABLE "public"."flows" ADD COLUMN "publicExpiresAt" TIMESTAMPTZ(6);
ALTER TABLE "public"."flows" ADD COLUMN "publicAllowCopy" BOOLEAN NOT NULL DEFAULT false;

-- Links already in circulation keep opening the public page: their digest
-- moves to the public column (the plaintext was never stored, so there is no
-- ciphertext for them — the panel offers a rotate). The digest leaves the
-- share column, which is what stops the same token admitting collaborators.
-- People who already joined by it keep their flow_collaborators rows.
UPDATE "public"."flows"
SET "publicTokenDigest" = "shareTokenDigest", "shareTokenDigest" = NULL
WHERE "shareAnonymous" = true AND "shareTokenDigest" IS NOT NULL;

CREATE UNIQUE INDEX "flows_publicTokenDigest_key" ON "public"."flows"("publicTokenDigest");
