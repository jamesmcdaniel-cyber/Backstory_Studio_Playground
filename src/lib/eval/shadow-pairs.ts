/**
 * Complete-pair fetch for the Models tab's shadow comparisons.
 *
 * The original query fetched shadow rows with `orderBy: createdAt desc, take:
 * 4000` and paired them up in memory. Two rows of one pair are written in the
 * same createMany statement and normally share an identical `createdAt` (same
 * transaction timestamp) — so when many pairs land in the same window edge
 * with tied timestamps, Postgres's tie-break order is not guaranteed to keep
 * a pair's two rows adjacent, and a flat row LIMIT can return one side of a
 * pair without the other. That half-pair was then silently dropped by the
 * in-memory grouping in the route (see the "missing a side" comment there) —
 * silently discarding real evidence instead of visibly capping the window.
 *
 * The fix: pick which PAIRS are in scope first (bounded by count of pairs,
 * not rows), then fetch every row for exactly those pairIds with no further
 * limit. A pairId is either fully in or fully out — never split.
 */

export type ShadowPairRow = {
  pairId: string | null
  provider: string
  model: string
  score: unknown
  champion: boolean | null
  costUsd: unknown
}

// Accepts both the real PrismaClient (whose findMany overloads are keyed to
// its generated arg types) and a test double built from plain objects.
type ShadowPairPrisma = {
  modelEvalResult: {
    findMany: (args: any) => Promise<any>
  }
}

// 2000 pairs = 4000 rows at most — same headroom as the old row-based cap,
// far past what a sampled shadow rate produces in 90 days (see the route).
export const SHADOW_PAIR_CAP = 2000

/**
 * Fetch every row of every shadow pair that started in the window, up to
 * `cap` pairs (by most recent). Returns `capped: true` when the window held
 * at least `cap` pairs, so the caller can disclose "not all pairs shown"
 * instead of silently truncating.
 */
export async function fetchCompleteShadowPairs(
  prisma: ShadowPairPrisma,
  since: Date,
  cap: number = SHADOW_PAIR_CAP,
): Promise<{ rows: ShadowPairRow[]; capped: boolean }> {
  const pairIdRows = (await prisma.modelEvalResult.findMany({
    where: { kind: 'shadow', createdAt: { gte: since }, pairId: { not: null } },
    select: { pairId: true },
    distinct: ['pairId'],
    orderBy: { createdAt: 'desc' },
    take: cap,
  })) as { pairId: string | null }[]
  const pairIds = pairIdRows.map((row) => row.pairId).filter((id): id is string => id != null)
  if (pairIds.length === 0) return { rows: [], capped: false }

  const rows = (await prisma.modelEvalResult.findMany({
    where: { kind: 'shadow', pairId: { in: pairIds } },
    select: { pairId: true, provider: true, model: true, score: true, champion: true, costUsd: true },
  })) as ShadowPairRow[]

  return { rows, capped: pairIdRows.length >= cap }
}
