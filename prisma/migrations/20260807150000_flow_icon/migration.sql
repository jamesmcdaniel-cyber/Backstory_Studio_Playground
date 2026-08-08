-- Per-flow emoji icon, seeded from the template on instantiate. '' = generic glyph.
ALTER TABLE "flows" ADD COLUMN "icon" TEXT NOT NULL DEFAULT '';
