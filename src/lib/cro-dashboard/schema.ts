import { CRO_DASHBOARD_TEMPLATE } from './template'

/**
 * The data the CRO dashboard page reads, and the checks it must pass before it
 * is embedded. The page never changes per run; only this object does.
 */

export const CRO_REASONS = [
  'Procurement & Legal',
  'Budget & Pricing',
  'Stakeholder Access',
  'Customer Priority & Resourcing',
  'Competitive',
  'Product Gap',
  'Technical / Integration',
  'Deal Execution Gap',
  'Low Engagement',
] as const
export type CroReason = (typeof CRO_REASONS)[number]

export const CRO_DEAL_TYPES = ['New Business', 'Upsell', 'Renewal', 'Renewal + Upsell'] as const
export type CroDealType = (typeof CRO_DEAL_TYPES)[number]

export type CroQuarter = { key: string; label: string; start: string; end: string; role: string }

export type CroEngage = {
  name: string
  title: string | null
  side: 'customer' | 'internal'
  role: string
  status: 'engaged' | 'not_engaged' | 'to_identify'
  why: string
}

export type CroAction = { action: string; owner: string; by: string; unblocks: string; source: string; engage: CroEngage[] }

export type CroDeal = {
  id: string
  name: string
  acct: string
  tier: string | null
  csm: string | null
  owner: string | null
  se: string | null
  dtype: CroDealType
  stage: string
  amt: number | null
  close: string
  q: string
  status: 'on_track' | 'not_on_track' | 'unanalyzed'
  severity?: 'slipping' | 'at_risk' | null
  reason?: CroReason | null
  secondary?: CroReason[]
  outcome?: string
  evidence?: string
  onTrackNote?: string
  backstoryRisks?: string[]
  recordedNextStep?: string
  customerActions?: CroAction[]
  internalActions?: CroAction[]
  situationNote?: string
  people?: { champion: null; economicBuyer: null; execSponsor: null; se: string | null; csm: string | null; owner: string | null }
}

export type CroDashboardData = {
  today: string
  builtAt: string
  /** Who "we" are on the page, from Backstory's internal group. Empty reads as "Internal". */
  seller: string
  fiscalYearStartMonth: number
  quarters: CroQuarter[]
  notes: string[]
  deals: CroDeal[]
}

const REASON_SET = new Set<string>(CRO_REASONS)
const TYPE_SET = new Set<string>(CRO_DEAL_TYPES)

/** Every way the data does not match what the page expects. Empty means it may be published. */
export function validateCroData(data: CroDashboardData): string[] {
  const errors: string[] = []
  if (!data.quarters?.length) errors.push('quarters is empty')
  const quarterKeys = new Set(data.quarters?.map((quarter) => quarter.key))
  const seen = new Set<string>()
  for (const deal of data.deals ?? []) {
    const label = deal.acct || deal.id
    for (const key of ['id', 'name', 'acct', 'dtype', 'stage', 'close', 'q', 'status'] as const) {
      if (!deal[key]) errors.push(`${label}: missing ${key}`)
    }
    if (seen.has(deal.id)) errors.push(`${label}: duplicate id ${deal.id}`)
    seen.add(deal.id)
    if (!quarterKeys.has(deal.q)) errors.push(`${label}: quarter ${deal.q} is not on the page`)
    if (!TYPE_SET.has(deal.dtype)) errors.push(`${label}: deal type ${deal.dtype} is not one of the four`)
    if (deal.status === 'on_track') {
      if (deal.reason || deal.severity || deal.customerActions?.length || deal.internalActions?.length) {
        errors.push(`${label}: an on-track deal has no reason, severity or recommendations`)
      }
    } else if (deal.status === 'not_on_track') {
      if (deal.severity !== 'slipping' && deal.severity !== 'at_risk') errors.push(`${label}: not on track needs a severity`)
      if (!deal.reason || !REASON_SET.has(deal.reason)) errors.push(`${label}: reason ${deal.reason} is not one of the nine`)
      if (!deal.customerActions?.length && !deal.internalActions?.length) errors.push(`${label}: not on track needs a recommendation`)
      for (const actions of [deal.customerActions ?? [], deal.internalActions ?? []]) {
        if (actions.length > 3) errors.push(`${label}: more than 3 recommendations on one side`)
        for (const action of actions) {
          for (const key of ['action', 'owner', 'by', 'unblocks', 'source'] as const) {
            if (!action[key]) errors.push(`${label}: a recommendation is missing ${key}`)
          }
          if (!action.engage?.length) errors.push(`${label}: a recommendation has no stakeholders to engage`)
        }
      }
    } else if (deal.status !== 'unanalyzed') {
      errors.push(`${label}: status ${deal.status} is invalid`)
    }
  }
  return errors
}

const PLACEHOLDER = '/*__DATA__*/null'

/** Embed the data in the fixed page. Throws with every problem when the data is not valid. */
export function renderCroDashboard(data: CroDashboardData): string {
  const errors = validateCroData(data)
  if (errors.length) throw new Error(`The dashboard data does not match the page: ${errors.slice(0, 10).join('; ')}`)
  // Deal text is customer data: it must not be able to close the script block.
  const json = JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\u0021--')
  // A function, so a "$&" in deal text is not read as a replacement pattern.
  return CRO_DASHBOARD_TEMPLATE.replace(PLACEHOLDER, () => json)
}
