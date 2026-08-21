import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCompleteShadowPairs, SHADOW_PAIR_CAP } from '../shadow-pairs'

/**
 * Regression for the shadow-pairs-split-at-the-window-edge bug: the old query
 * fetched shadow ROWS with `take: 4000` ordered by createdAt, and paired them
 * up in memory — so when a cutoff landed mid-pair (two rows sharing a tied
 * createdAt, common since both sides of a pair are written in one createMany
 * statement), one side of the pair silently vanished. The fix picks which
 * PAIRS are in scope first, then fetches every row for exactly those pairIds
 * with no further limit, so a pairId is always fully in or fully out.
 *
 * A fake prisma stands in for systemPrisma here: the first call (distinct
 * pairId select) and the second call (full rows for chosen pairIds) are
 * exercised against an in-memory row set built to have far more pairs than
 * the cap, with several pairs deliberately given the exact same createdAt —
 * the tie that used to split a pair at the LIMIT boundary.
 */

type Row = {
  pairId: string
  provider: string
  model: string
  score: number
  champion: boolean
  costUsd: number
  createdAt: Date
}

function fakePrisma(rows: Row[]) {
  return {
    modelEvalResult: {
      findMany: async (args: any) => {
        if (args.distinct) {
          // Distinct pairId, ordered by createdAt desc, capped at `take`.
          const seen = new Set<string>()
          const ordered = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          const out: { pairId: string }[] = []
          for (const row of ordered) {
            if (seen.has(row.pairId)) continue
            seen.add(row.pairId)
            out.push({ pairId: row.pairId })
            if (out.length >= args.take) break
          }
          return out
        }
        // Full-row fetch for an explicit pairId IN list — no limit, so every
        // row for a chosen pairId comes back regardless of createdAt.
        const wantedIds = new Set<string>(args.where.pairId.in)
        return rows.filter((row) => wantedIds.has(row.pairId))
      },
    },
  }
}

function makePairs(count: number, tiedCreatedAt: Date): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < count; i += 1) {
    const pairId = `pair-${i}`
    // All pairs share the exact same createdAt — the tie that a flat row
    // LIMIT cannot safely cut through without risking a half-pair.
    rows.push({ pairId, provider: 'anthropic', model: 'claude-sonnet-5', score: 0.8, champion: true, costUsd: 0, createdAt: tiedCreatedAt })
    rows.push({ pairId, provider: 'qwen', model: 'qwen-3.7', score: 0.7, champion: false, costUsd: 0.01, createdAt: tiedCreatedAt })
  }
  return rows
}

test('every returned pair has both sides — a chosen pairId is never split', async () => {
  const tiedAt = new Date('2026-08-20T00:00:00.000Z')
  const cap = 5
  const rows = makePairs(20, tiedAt) // far more pairs than the cap
  const prisma = fakePrisma(rows)

  const { rows: result, capped } = await fetchCompleteShadowPairs(prisma as any, new Date(0), cap)

  assert.equal(capped, true)
  // Every row must come back in pairs: group and check both sides present.
  const byPair = new Map<string, { champion?: Row; challenger?: Row }>()
  for (const row of result as unknown as Row[]) {
    const entry = byPair.get(row.pairId) ?? {}
    if (row.champion) entry.champion = row
    else entry.challenger = row
    byPair.set(row.pairId, entry)
  }
  assert.equal(byPair.size, cap, 'exactly `cap` pairs should be in scope')
  for (const [pairId, entry] of byPair) {
    assert.ok(entry.champion, `pair ${pairId} is missing its champion side`)
    assert.ok(entry.challenger, `pair ${pairId} is missing its challenger side`)
  }
})

test('under the cap, capped is false and every pair in the window is returned', async () => {
  const rows = makePairs(3, new Date('2026-08-20T00:00:00.000Z'))
  const prisma = fakePrisma(rows)
  const { rows: result, capped } = await fetchCompleteShadowPairs(prisma as any, new Date(0), 10)
  assert.equal(capped, false)
  assert.equal(result.length, 6) // 3 complete pairs, both sides each
})

test('no shadow rows in the window returns an empty, uncapped result', async () => {
  const prisma = fakePrisma([])
  const { rows, capped } = await fetchCompleteShadowPairs(prisma as any, new Date(0), SHADOW_PAIR_CAP)
  assert.deepEqual(rows, [])
  assert.equal(capped, false)
})
