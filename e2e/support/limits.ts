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

/** Flow runs one person may START per UTC day, before the ceiling refuses them. */
export const FREE_TIER_FLOW_RUNS_PER_DAY = 5

/** Agent runs one person may START per UTC day. */
export const FREE_TIER_AGENT_RUNS_PER_DAY = 5

/** Connected integrations per workspace (MCP servers and HTTP credentials excluded). */
export const FREE_TIER_INTEGRATIONS = 3

export const LIMIT_MESSAGE = {
  flowRuns: (limit: number) => `You have used all ${limit} flow runs for today. The limit resets at midnight UTC.`,
  agentRuns: (limit: number) => `You have used all ${limit} agent runs for today. The limit resets at midnight UTC.`,
  integrations: (limit: number) =>
    `This workspace has reached its limit of ${limit} connected integrations. Disconnect one, or ask a workspace owner to raise the limit.`,
}
