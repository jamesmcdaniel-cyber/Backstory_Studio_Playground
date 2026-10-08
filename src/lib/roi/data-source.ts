import { prisma } from '@/lib/prisma'
import { resolveRoiDatasetIds, ROI_TEMPLATES, type RoiTemplate } from './sources'
import type { RoiRunConfig } from './config'

/**
 * Where an ROI run's data comes from — the one seam between the page and
 * the warehouse.
 *
 * Today the account's extracts are already in the workspace Repository
 * (loaded by an operator, tagged `sourceMetadata.roi`), so fetching is a
 * lookup and the run starts at once.
 *
 * Once an admin connects a data flow (the ROI Analyst's `roiDataFlowId`,
 * set on the ROI page), a run starts that flow instead. Its contract:
 *   input   { account, analysisId, reason, config } — the flow resolves the
 *           account's People.ai org/tenant id and pulls ~2 years from
 *           Databricks/Snowflake; the config slices it later, not the query;
 *   effect  writes each extract to the Repository as a dataset tagged
 *           `sourceMetadata.roi = { account, kind, loadedAt }` (loadRoiSource
 *           does exactly this), replacing nothing;
 *   finish  succeeds or fails like any flow run. Its completion hands the
 *           analysis back to the service (continueRoiAnalysisAfterDataFlow),
 *           which resolves the freshly tagged extracts and starts the analyst.
 * Nothing downstream changes when the flow lands: the analyst always reads
 * tagged Repository datasets.
 */

export type RoiDataResult =
  | { kind: 'ready'; datasetIds: string[] }
  | { kind: 'fetching'; flowRunId: string }

export class RoiDataUnavailableError extends Error {}

/** The trigger a data-flow run carries, so its completion finds its analysis. */
export const ROI_DATA_FLOW_SOURCE = 'roi_analysis'

export function roiAnalysisIdOfTrigger(trigger: unknown): string | null {
  const value = trigger as { source?: unknown; roiAnalysisId?: unknown } | null
  return value?.source === ROI_DATA_FLOW_SOURCE && typeof value.roiAnalysisId === 'string' ? value.roiAnalysisId : null
}

export async function fetchRoiData(params: {
  organizationId: string
  userId: string
  analysisId: string
  account: string
  reason: string
  config: RoiRunConfig
  template: RoiTemplate
  dataFlowId: string | null
}): Promise<RoiDataResult> {
  if (params.dataFlowId) {
    const flow = await prisma.flow.findFirst({ where: { id: params.dataFlowId, organizationId: params.organizationId }, select: { id: true, name: true } })
    if (!flow) throw new RoiDataUnavailableError('The data flow connected to the ROI page no longer exists. An admin can pick another on the ROI analysis page.')
    const { startFlowExecution } = await import('@/features/flows/execute-flow')
    const started = await startFlowExecution({
      flowId: flow.id,
      organizationId: params.organizationId,
      userId: params.userId,
      usePublished: true,
      input: { account: params.account, analysisId: params.analysisId, reason: params.reason, config: params.config },
      trigger: { type: 'manual', source: ROI_DATA_FLOW_SOURCE, roiAnalysisId: params.analysisId },
    })
    return { kind: 'fetching', flowRunId: started.flowRunId }
  }
  return { kind: 'ready', datasetIds: await loadedExtracts(params.organizationId, params.account, params.template) }
}

/** The account's tagged extracts, or a plain-English reason there are none. */
export async function loadedExtracts(organizationId: string, account: string, template: RoiTemplate): Promise<string[]> {
  const ids = await resolveRoiDatasetIds(organizationId, account, template)
  if (!ids.length) throw new RoiDataUnavailableError(`"${account.trim()}" has no warehouse data in the workspace yet, so its ${ROI_TEMPLATES[template].label} cannot be built. Its page shows the account live from Backstory and Salesforce until the data flow brings the rest.`)
  return ids
}

/** Whether a run could compute the account's data afresh: the data flow is connected, or its extracts are loaded. */
export async function canComputeRoiData(organizationId: string, account: string, dataFlowId: string | null): Promise<boolean> {
  if (dataFlowId && await prisma.flow.findFirst({ where: { id: dataFlowId, organizationId }, select: { id: true } })) return true
  return (await resolveRoiDatasetIds(organizationId, account, 'standard')).length > 0
}
