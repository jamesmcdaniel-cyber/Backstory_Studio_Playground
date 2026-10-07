import { prisma } from '@/lib/prisma'
import { backstoryMcpReady } from '@/lib/mcp/backstory-connection'
import { findRoiAgent, roiDataFlowIdOf } from './agent'
import { coversFor, listRoiSources } from './sources'
import { listAccountReports, ROI_ASYNC_AFTER_SECONDS, ROI_EXPECTED_SECONDS, ROI_RECONFIGURE_EXPECTED_SECONDS, type AccountReport } from './service'
import { loadPersonalPage, type PersonalPage } from './personal-page'
import type { RoiPageAccount, RoiPageSetup } from './types'

/** The account everyone starts on once its report is built: Backstory's own value readout. */
export const ROI_DEFAULT_ACCOUNT = 'Backstory'

const ACTIVE_STATUSES = ['pending', 'fetching', 'running', 'building']

/**
 * One account as this person sees it: the account's report (everyone's
 * starting point), their own page's latest version of it, and whether the
 * report has data their page does not show yet.
 */
export function pageAccountOf(params: {
  account: string
  extracts: RoiPageAccount['extracts']
  covers: string[]
  loadedAt: string | null
  canRefresh: boolean
  report: AccountReport | null
  page: PersonalPage | null
  /** This person's run on the account, if one is in flight. */
  myActiveRun: string | null
}): RoiPageAccount {
  const { report } = params
  const mine = params.page?.accounts[params.account.trim().toLowerCase()] ?? null
  return {
    account: params.account,
    extracts: params.extracts,
    covers: params.covers,
    loadedAt: params.loadedAt,
    report: report
      ? { artifactId: report.artifactId, versionId: report.currentVersionId, ready: Boolean(report.state || report.a360), config: report.config, reason: report.reason, factsCurrent: report.factsCurrent, updatedAt: report.updatedAt }
      : null,
    mine: mine ? { versionId: mine.versionId, config: mine.config, reason: mine.reason, factsCurrent: mine.factsCurrent, updatedAt: mine.createdAt, ...(mine.stale ? { stale: true } : {}) } : null,
    newerData: Boolean(mine && (report?.state || report?.a360) && report?.currentVersionId && mine.basedOnVersionId && mine.basedOnVersionId !== report.currentVersionId),
    activeAnalysisId: params.myActiveRun ?? report?.activeAnalysisId ?? null,
    canRefresh: params.canRefresh,
  }
}

/**
 * What the ROI analysis page draws its form from: the accounts it can run,
 * the private admin agent behind it, where a run's data comes from, and
 * whether the analyst can reach the Backstory platform for this person.
 *
 * Only the analyst's owner configures it (it is private): before the first
 * run provisions it, any workspace admin may — they become its owner.
 */
export async function loadRoiPageSetup(params: { organizationId: string; userId: string; role: string; canWriteAgents: boolean; canLoadExtracts?: boolean }): Promise<RoiPageSetup> {
  const [sources, agent, backstory] = await Promise.all([
    listRoiSources(params.organizationId),
    findRoiAgent(params.organizationId),
    backstoryMcpReady(params.organizationId, params.userId).catch(() => false),
  ])
  const isAdmin = params.role === 'ADMIN' || params.role === 'OWNER'
  const canConfigure = params.canWriteAgents && (agent ? agent.userId === params.userId : isAdmin)
  const owner = agent?.userId ? await prisma.user.findFirst({ where: { id: agent.userId, organizationId: params.organizationId }, select: { name: true, email: true } }) : null
  const flowId = roiDataFlowIdOf(agent)
  const flow = flowId ? await prisma.flow.findFirst({ where: { id: flowId, organizationId: params.organizationId }, select: { id: true, name: true } }) : null
  const flows = canConfigure
    ? await prisma.flow.findMany({ where: { organizationId: params.organizationId, status: { not: 'DISABLED' } }, orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, name: true, publishedGraph: true } })
    : []
  const metadata = (agent?.metadata ?? {}) as { title?: unknown; model?: unknown }
  const [reports, page, myRuns] = await Promise.all([
    listAccountReports(params.organizationId),
    loadPersonalPage(params.organizationId, params.userId),
    prisma.roiAnalysis.findMany({ where: { organizationId: params.organizationId, userId: params.userId, status: { in: ACTIVE_STATUSES } }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, account: true } }),
  ])
  const key = (account: string) => account.trim().toLowerCase()
  const reportOf = (account: string) => reports.find((entry) => key(entry.account) === key(account)) ?? null
  const myRunOf = (account: string) => myRuns.find((row) => key(row.account) === key(account))?.id ?? null
  const entry = (account: string, extras: Pick<RoiPageAccount, 'extracts' | 'covers' | 'loadedAt' | 'canRefresh'>) =>
    pageAccountOf({ account, ...extras, report: reportOf(account), page, myActiveRun: myRunOf(account) })
  const accounts: RoiPageSetup['accounts'] = sources
    .filter((source) => source.templates.includes('standard'))
    .map((source) => {
      const kinds = Object.keys(source.datasets) as Array<keyof typeof source.datasets>
      const loaded = kinds.map((kind) => source.datasets[kind]?.loadedAt).filter((value): value is string => Boolean(value)).sort()
      return entry(source.account, { extracts: kinds, covers: coversFor(kinds), loadedAt: loaded.at(-1) ?? null, canRefresh: true })
    })
  // Accounts with a report, or on this person's page, but no loaded data
  // still show (and can change settings); with a data flow they can be
  // refreshed too, as can accounts analysed before. New ones are typed on the page.
  const known = new Set(accounts.map((item) => key(item.account)))
  const add = (account: string, canRefresh: boolean) => {
    if (known.has(key(account))) return
    known.add(key(account))
    accounts.push(entry(account, { extracts: [], covers: [], loadedAt: null, canRefresh }))
  }
  for (const report of reports) add(report.account, Boolean(flow))
  for (const mine of Object.values(page?.accounts ?? {})) add(mine.account, Boolean(flow))
  // Backstory's own readout is everyone's starting page: it is listed before it is loaded.
  add(ROI_DEFAULT_ACCOUNT, Boolean(flow))
  if (flow) {
    const previous = await prisma.roiAnalysis.findMany({ where: { organizationId: params.organizationId }, distinct: ['account'], orderBy: { createdAt: 'desc' }, take: 200, select: { account: true } })
    for (const row of previous) add(row.account, true)
  }
  accounts.sort((a, b) => a.account.localeCompare(b.account))
  return {
    accounts,
    agent: {
      id: agent?.id ?? null,
      title: typeof metadata.title === 'string' && metadata.title ? metadata.title : 'ROI Analyst',
      model: typeof metadata.model === 'string' ? metadata.model : null,
      canConfigure,
      ownerName: owner ? owner.name?.trim() || owner.email || null : null,
    },
    dataSource: flow ? { kind: 'flow', flowId: flow.id, flowName: flow.name } : { kind: 'repository', flowId: null, flowName: null },
    flows: flows.map((row) => ({ id: row.id, name: row.name, published: Boolean(row.publishedGraph) })),
    backstory: { connected: backstory },
    expectedSeconds: ROI_EXPECTED_SECONDS,
    reconfigureSeconds: ROI_RECONFIGURE_EXPECTED_SECONDS,
    asyncAfterSeconds: ROI_ASYNC_AFTER_SECONDS,
    page: page ? { artifactId: page.artifactId, currentAccount: page.currentAccount } : null,
    // Backstory once its report exists — and for operators before, so they land where its readout loads.
    defaultAccount: accounts.find((item) => key(item.account) === key(ROI_DEFAULT_ACCOUNT) && (item.report?.ready || item.mine || params.canLoadExtracts))?.account ?? null,
    canLoadExtracts: params.canLoadExtracts === true,
  }
}
