-- Save-time secret scanning results for flow graphs.
--
-- A good scanner already existed (findSecretCandidates) but ran in exactly one
-- place — catalogue submission — and only as a warning to a reviewer. It never
-- ran on flow save, so a hardcoded API key in a step config was invisible until
-- someone happened to publish that flow to the catalogue.
--
-- Advisory, not blocking: refusing the save would read as data loss to the
-- author, who would then work around it. A flow that carries a literal
-- credential instead says so on its own card until it is fixed.
--
-- NULL means "not scanned yet" rather than "clean" — existing flows are
-- backfilled on their next save, and the UI distinguishes the two.

ALTER TABLE "flows"
  ADD COLUMN "secretFindings" JSONB,
  ADD COLUMN "secretScanAt" TIMESTAMP(3);
