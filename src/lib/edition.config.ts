import type { Edition } from './edition'

/**
 * THE ONLY FILE THAT DIFFERS BETWEEN Backstory_Studio AND Backstory_customers.
 *
 * Upstream (this repo) is 'internal'. The customer fork sets 'customer' and
 * changes nothing else, so `git merge upstream/main` never conflicts here —
 * upstream never edits this file.
 *
 * This is a committed constant rather than an env var on purpose: an env var
 * can be omitted on a fresh deploy and would FAIL OPEN, silently granting a
 * customer deployment the staff console and the AI generation pipeline. It also
 * works uniformly in all three runtimes (Next server, browser bundle, and the
 * tsx worker), where a NEXT_PUBLIC_ var would need separate handling.
 */
export const EDITION: Edition = 'internal'
