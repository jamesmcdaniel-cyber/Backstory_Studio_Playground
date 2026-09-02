/**
 * RAG + grounding eval benchmark. Run on-demand: `npm run eval:rag`.
 *
 * Gated on VOYAGE_API_KEY (retrieval needs real embeddings) + a throwaway
 * Postgres with pgvector (DATABASE_URL — point it at a disposable DB; this
 * creates and deletes its own org). Grounding metrics (Task 4) additionally
 * need a model key and are skipped when absent, mirroring the existing judge.
 *
 * This is a benchmark, not a CI gate: it prints a scorecard + a floor-threshold
 * sweep and writes scorecard.latest.json (git-ignored) for tracking over time.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '@/lib/prisma'
import { embeddingsConfigured } from '@/lib/rag/embeddings'
import { retrieveKnowledge, renderKnowledge } from '@/lib/knowledge/retrieve'
import { KNOWLEDGE_RELEVANCE_FLOOR } from '@/lib/rag/relevance'
import { seedCorpus } from './seed'
import { loadGolden, filenameToDocId, CORPUS_DIR } from './index'
import { retrievalMetrics, recallAtK, mean } from './metrics'
import { generateGroundedAnswer, isRefusal } from './answer'
import { judgeGrounding } from './judge'
import type { GoldenItem, RagScorecard, SweepRow, GroundingMetrics } from './types'

export const SWEEP_FLOORS = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]

/** Gates the grounding pass — mirrors the eval judge's own gating (skips
 * without a model key). hasAnthropic in model-runner.ts is NOT
 * exported, so this checks the env vars directly rather than importing them. */
function modelKeyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

/** One query's retrieval result: the ranked corpus doc ids + their scores. */
interface Retrieved {
  item: GoldenItem
  docIds: string[]
  scores: number[]
}

async function retrieveAll(organizationId: string, agentId: string, golden: GoldenItem[]): Promise<Retrieved[]> {
  const out: Retrieved[] = []
  for (const item of golden) {
    // Raw retrieval (no floor) at k=10 so the sweep can filter over one ranked list.
    const hits = await retrieveKnowledge({ organizationId, agentId, query: item.query, k: 10 })
    out.push({
      item,
      docIds: hits.map((h) => filenameToDocId(h.filename)),
      scores: hits.map((h) => h.score),
    })
  }
  return out
}

/** Recall@5 at a given floor: keep only hits scoring >= floor, then measure. */
function sweep(retrieved: Retrieved[]): SweepRow[] {
  const answerable = retrieved.filter((r) => r.item.sourceDocIds.length > 0)
  return SWEEP_FLOORS.map((floor) => {
    const perQuery = answerable.map((r) => {
      const kept = r.docIds.filter((_, i) => r.scores[i] >= floor)
      return recallAtK(kept, r.item.sourceDocIds, 5)
    })
    return { floor, meanRecallAt5: mean(perQuery), meanFaithfulness: null }
  })
}

/** Grade grounding on the golden set: faithfulness + answer-relevance on answerable
 *  items, refusal-rate on unanswerable ones. Uses the real floored retrieval. */
async function grade(organizationId: string, agentId: string, golden: GoldenItem[]): Promise<GroundingMetrics> {
  const faithfulness: number[] = []
  const relevance: number[] = []
  let refusals = 0
  let judged = 0
  for (const item of golden) {
    const hits = await retrieveKnowledge({ organizationId, agentId, query: item.query, k: 5, minScore: KNOWLEDGE_RELEVANCE_FLOOR })
    const context = renderKnowledge(hits)
    const answer = await generateGroundedAnswer(item.query, context)
    if (item.unanswerable) {
      if (isRefusal(answer)) refusals += 1
    } else {
      const scores = await judgeGrounding(item.query, answer, context)
      faithfulness.push(scores.faithfulness)
      relevance.push(scores.answerRelevance)
    }
    judged += 1
  }
  const unanswerable = golden.filter((g) => g.unanswerable).length
  return {
    meanFaithfulness: mean(faithfulness),
    meanAnswerRelevance: mean(relevance),
    refusalRate: unanswerable > 0 ? refusals / unanswerable : 0,
    judged,
  }
}

export async function runRagEval(): Promise<RagScorecard> {
  if (!embeddingsConfigured()) {
    throw new Error('eval:rag needs VOYAGE_API_KEY (real embeddings). Set it and point DATABASE_URL at a throwaway pgvector DB.')
  }

  // Disposable org + agent; deleted in `finally` (org delete cascades knowledge).
  const org = await prisma.organization.create({ data: { name: 'rag-eval', slug: `rag-eval-${process.pid}-${process.hrtime.bigint()}` } })
  const agent = await prisma.agentTask.create({ data: { organizationId: org.id, description: 'rag-eval agent', objective: 'eval' } })

  try {
    const corpusDocs = await seedCorpus(org.id, agent.id)
    const golden = loadGolden()
    const retrieved = await retrieveAll(org.id, agent.id, golden)

    const retrieval = retrievalMetrics(retrieved.map((r) => ({ retrieved: r.docIds, gold: r.item.sourceDocIds })))
    const sweepRows = sweep(retrieved)
    const grounding = modelKeyConfigured() ? await grade(org.id, agent.id, golden) : null

    const scorecard: RagScorecard = {
      corpusDocs,
      goldenItems: golden.length,
      answerable: golden.filter((g) => !g.unanswerable).length,
      unanswerable: golden.filter((g) => g.unanswerable).length,
      retrieval,
      grounding,
      sweep: sweepRows,
      generatedAtIso: new Date().toISOString(),
    }
    return scorecard
  } finally {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
  }
}

function printScorecard(card: RagScorecard): void {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`
  console.log('\n=== RAG eval scorecard ===')
  console.log(`corpus docs: ${card.corpusDocs} | golden: ${card.goldenItems} (${card.answerable} answerable, ${card.unanswerable} unanswerable)`)
  console.log(`recall@3=${pct(card.retrieval.recallAt3)} recall@5=${pct(card.retrieval.recallAt5)} recall@10=${pct(card.retrieval.recallAt10)} MRR=${card.retrieval.mrr.toFixed(3)}`)
  console.log('\nfloor sweep (recall@5 of injected hits):')
  for (const row of card.sweep) {
    const faith = row.meanFaithfulness == null ? 'n/a' : pct(row.meanFaithfulness)
    console.log(`  floor ${row.floor.toFixed(2)}: recall@5=${pct(row.meanRecallAt5)} faithfulness=${faith}`)
  }
  if (card.grounding) {
    console.log(`\ngrounding: faithfulness=${pct(card.grounding.meanFaithfulness)} answer-relevance=${pct(card.grounding.meanAnswerRelevance)} refusal-rate=${pct(card.grounding.refusalRate)} (judged ${card.grounding.judged})`)
  } else {
    console.log('\ngrounding: skipped (no model key)')
  }
}

// Entry point when run directly via `npm run eval:rag`.
async function main(): Promise<void> {
  const card = await runRagEval()
  printScorecard(card)
  writeFileSync(join(CORPUS_DIR, '..', 'scorecard.latest.json'), JSON.stringify(card, null, 2))
  await prisma.$disconnect()
}

if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
