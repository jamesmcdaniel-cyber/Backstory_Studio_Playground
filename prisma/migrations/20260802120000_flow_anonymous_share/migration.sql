-- Anonymous share links: a share token may additionally be opened WITHOUT
-- signing in, on a dedicated read-only page. Deliberately separate from
-- shareRole — an anonymous open is always view-only, never edit.
ALTER TABLE "flows" ADD COLUMN "shareAnonymous" BOOLEAN NOT NULL DEFAULT false;
-- Owner-visible signal that a public link is being opened (and how much).
ALTER TABLE "flows" ADD COLUMN "anonymousViews" INTEGER NOT NULL DEFAULT 0;
