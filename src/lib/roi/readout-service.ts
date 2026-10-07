import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { addVersion, createArtifact } from '@/lib/artifacts/service'
import { stateJson, storeFacts, type RoiArtifactState } from './artifact-state'
import { DEFAULT_RUN_CONFIG, type RoiRunConfig } from './config'
import { renderRoiDashboard, ROI_RENDER_VERSION } from './dashboard'
import { ensureRoiAgent } from './agent'
import { runKpis } from './kpis'
import { extractReadoutData, readoutFacts, readoutNarrative } from './readout-import'
import { findAccountReport, openRoiAccount, type OpenResult } from './service'
import { EMPTY_VIEW } from './view'

/** The account a readout lands on unless another is named: Backstory's own. */
export const READOUT_DEFAULT_ACCOUNT = 'Backstory'

/** The month a readout's fiscal year starts in, from its deal rows (the first month of its Q1). */
function fiscalStartOf(rows: Array<{ m: string; fq: string }>): number | null {
  const months = new Set(rows.filter((row) => row.fq === 'Q1' && /^\d{4}-\d{2}$/.test(row.m)).map((row) => Number(row.m.slice(5, 7))))
  for (const month of months) if (!months.has(month === 1 ? 12 : month - 1)) return month
  return null
}

/**
 * Load a value readout (an .html page with its data embedded) as an
 * account's report: Backstory's own by default. The report is built from the
 * readout alone — no extracts, no run — and lands on the account's report
 * (a new version when it has one) and on the loader's own page.
 */
export async function importReadout(params: { organizationId: string; userId: string; html: string; account?: string }): Promise<{ account: string; created: boolean; result: OpenResult }> {
  const data = extractReadoutData(params.html)
  const existing = await findAccountReport(params.organizationId, params.account?.trim() || READOUT_DEFAULT_ACCOUNT)
  const account = existing?.account ?? (params.account?.trim() || READOUT_DEFAULT_ACCOUNT)
  const facts = readoutFacts(data)
  const narrative = readoutNarrative(data, account, params.html, facts)
  const config: RoiRunConfig = { ...DEFAULT_RUN_CONFIG, fiscalYearStartMonth: fiscalStartOf(facts.AGG?.deals.monthly ?? []) }
  const reason = `${account} value readout`
  const agent = await ensureRoiAgent(params.organizationId, params.userId)
  const factsFileId = await storeFacts(params.organizationId, params.userId, facts)
  const state: RoiArtifactState['roi'] = {
    analysisId: `readout:${Date.now()}`,
    account,
    timeframePreset: 'last6_vs_prior6',
    factsFileId,
    datasetIds: [],
    narrative,
    view: existing?.state?.view ?? EMPTY_VIEW,
    config,
    reason,
    source: 'readout',
    render: ROI_RENDER_VERSION,
  }
  const html = renderRoiDashboard(facts, narrative, { account, generatedAt: new Date().toISOString(), view: state.view, config, reason })
  let artifactId: string
  let versionId: string
  if (existing && !existing.a360) {
    const version = await addVersion({ artifactId: existing.artifactId, organizationId: params.organizationId, content: html, request: `${account} · value readout loaded`, createdByUserId: params.userId, state: stateJson(state) })
    artifactId = existing.artifactId
    versionId = version.id
  } else {
    const created = await createArtifact({ organizationId: params.organizationId, userId: params.userId, kind: 'roi_dashboard', title: `ROI analysis · ${account}`, content: html, agentTaskId: agent.id, state: stateJson(state) })
    artifactId = created.artifact.id
    versionId = created.version.id
  }
  // The report's history: a finished build, so it lists as the account's report.
  await prisma.roiAnalysis.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentTaskId: agent.id,
      artifactId,
      account,
      template: 'standard',
      timeframe: { preset: 'last6_vs_prior6' },
      config: config as unknown as Prisma.InputJsonValue,
      reason,
      context: '',
      datasetIds: [],
      status: 'completed',
      results: JSON.parse(JSON.stringify({ narrative, factsFileId, artifactId, versionId, mode: 'full', source: 'readout', kpis: runKpis(facts, null, config) })) as Prisma.InputJsonValue,
    },
  })
  const result = await openRoiAccount({ organizationId: params.organizationId, userId: params.userId, account, update: true })
  return { account, created: !existing || Boolean(existing.a360), result }
}
