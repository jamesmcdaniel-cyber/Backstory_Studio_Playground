/**
 * The free-tier ceilings and the exact sentences a refused person reads.
 *
 * ── Why these are copied rather than imported ────────────────────────────
 * `src/lib/usage/free-tier-limits.ts` exports both the numbers and
 * `limitMessage()`, and importing them would keep this file automatically in
 * step. That is precisely the problem: a test that asks the implementation
 * what the message is can never notice the message changing. It would pass
 * just as happily if the copy became "QUOTA_EXCEEDED (code 429)" — the exact
 * regression a user-facing assertion exists to catch.
 *
 * So these are written out independently, as a statement of what the product
 * promises. If a deliberate copy change breaks this file, updating it is the
 * correct response — and the diff is then a visible record that the wording
 * people see was changed on purpose.
 *
 * (Importing would also drag in @/lib/prisma through the module graph, which
 * the browser suite has no business loading.)
 */

/**
 * Daily run ceilings: none. Lifted for every user on 2026-11-17 — the journey
 * now proves a person with a busy day of runs is still let through. This is the
 * size of that busy day: more than twice the old cap of 5.
 */
export const BUSY_DAY_FLOW_RUNS = 12

/** Connected integrations per workspace (MCP servers and HTTP credentials excluded). */
export const FREE_TIER_INTEGRATIONS = 3

export const LIMIT_MESSAGE = {
  integrations: (limit: number) =>
    `This workspace has reached its limit of ${limit} connected integrations. Disconnect one, or ask a workspace owner to raise the limit.`,
}
