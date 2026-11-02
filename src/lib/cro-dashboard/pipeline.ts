import type { CroDealType, CroQuarter } from './schema'

/**
 * Reading Backstory MCP answers into the deal rows the dashboard is built on.
 * All deterministic: amounts, dates, owners and quarters never pass through a
 * model. What Backstory does not expose (tier, account health, the CSM field)
 * stays empty or is taken from evidence, and the page's notes say so.
 */

/** An MCP answer as plain data: JSON text, `content` blocks, or `{ result }`. */
export function mcpPayload(raw: unknown): unknown {
  let value = raw
  const blocks = (value as { content?: Array<{ text?: unknown }> } | null)?.content
  if (Array.isArray(blocks) && typeof blocks[0]?.text === 'string') value = blocks[0].text
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return value
    }
  }
  const structured = (value as { structuredContent?: unknown } | null)?.structuredContent
  return structured ?? value
}

/** The text of a tool that answers in prose (`{ result: "..." }`). */
export function mcpText(raw: unknown): string {
  const value = mcpPayload(raw)
  if (typeof value === 'string') return value
  const result = (value as { result?: unknown } | null)?.result
  return typeof result === 'string' ? result : JSON.stringify(value ?? '')
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Mar 02, 2027" or "2027-03-02" as an ISO date; null when it is neither. */
export function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  const match = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/.exec(value.trim())
  if (!match) return null
  const month = MONTHS.indexOf(match[1].toLowerCase())
  return month < 0 ? null : `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`
}

export type OpenDeal = { id: string; name: string; accountId: string; account: string; close: string; amount: number | null; stage: string }

/** The rows of a fetch_records answer. Throws when the answer is not a record list: an outage must not read as an empty pipeline. */
export function parseOpenDeals(raw: unknown): { deals: OpenDeal[]; total: number } {
  const value = mcpPayload(raw) as { records?: unknown; total_matching?: unknown } | null
  if (!Array.isArray(value?.records)) throw new Error('Backstory did not return a record list.')
  const deals: OpenDeal[] = []
  for (const record of value.records as Array<Record<string, unknown>>) {
    const close = isoDate(record.ootb_opportunity_close_date)
    if (record.peopleai_opportunity_id == null || !close) continue
    deals.push({
      id: String(record.peopleai_opportunity_id),
      name: String(record.name ?? ''),
      accountId: String(record.account_id ?? ''),
      account: String(record.account_name ?? ''),
      close,
      amount: typeof record.ootb_opportunity_amount === 'number' ? record.ootb_opportunity_amount : null,
      stage: String(record.ootb_opportunity_current_stage ?? ''),
    })
  }
  return { deals, total: typeof value.total_matching === 'number' ? value.total_matching : deals.length }
}

export type AccountOpportunity = { owner: string | null; type: string | null }

/** Owner and type per opportunity id from a find_account answer, for the one account asked about. */
export function parseAccountOpportunities(raw: unknown, accountId: string): Map<string, AccountOpportunity> {
  const found = new Map<string, AccountOpportunity>()
  const accounts = (mcpPayload(raw) as { accounts?: unknown } | null)?.accounts
  if (!Array.isArray(accounts)) return found
  // find_account matches by name and can return a parent and its divisions.
  const account = (accounts as Array<Record<string, unknown>>).find((row) => String(row.peopleai_account_id) === accountId)
  for (const opportunity of (account?.opportunities ?? []) as Array<Record<string, unknown>>) {
    const owner = (opportunity.owner as { name?: unknown } | null)?.name
    found.set(String(opportunity.peopleai_opportunity_id), {
      owner: typeof owner === 'string' && owner ? owner : null,
      type: typeof opportunity.type === 'string' && opportunity.type ? opportunity.type : null,
    })
  }
  return found
}

/** The dashboard's four deal types from the CRM's type, or failing that the deal's name. */
export function dealTypeOf(type: string | null, name: string): { dtype: CroDealType; inferred: boolean } {
  const text = type || name
  const renewal = /renew/i.test(text)
  const upsell = /upsell|up-sell|cross[- ]?sell|expansion|add-?on/i.test(text)
  const dtype: CroDealType = renewal && upsell ? 'Renewal + Upsell' : renewal ? 'Renewal' : upsell ? 'Upsell' : 'New Business'
  return { dtype, inferred: !type }
}

export type EngagedPerson = { name: string; title: string | null; side: 'customer' | 'internal'; lastEngaged: string | null; emails: number; meetings: number }

const attribute = (tag: string, name: string) => {
  const value = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? ''
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/**
 * The people in a get_opportunity_engaged_people answer, without their email
 * addresses: those are never shown, and never sent on to a model.
 */
export function parseEngagedPeople(raw: unknown): { people: EngagedPerson[]; seller: string } {
  const text = mcpText(raw)
  const people: EngagedPerson[] = []
  for (const [side, tag] of [['customer', 'ExternalGroup'], ['internal', 'InternalGroup']] as const) {
    const group = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`).exec(text)?.[0] ?? ''
    for (const match of group.matchAll(/<(?:MostEngagedParticipant|Participant)\b[^>]*>/g)) {
      const name = attribute(match[0], 'name')
      if (!name) continue
      const title = attribute(match[0], 'job_title')
      people.push({
        name,
        title: title && title !== 'null' ? title : null,
        side,
        lastEngaged: attribute(match[0], 'last_engaged') || null,
        emails: Number(attribute(match[0], 'email_count')) || 0,
        meetings: Number(attribute(match[0], 'meeting_count')) || 0,
      })
    }
  }
  const org = /<InternalGroup\b[^>]*\borg="([^"]*)"/.exec(text)?.[1]?.trim() ?? ''
  return { people, seller: org && org.toLowerCase() !== 'internal' ? org : '' }
}

/** The most engaged internal person with a title like this. Backstory has no CSM or SE field, so the title is the evidence. */
export function internalWithTitle(people: EngagedPerson[], title: RegExp): string | null {
  return people
    .filter((person) => person.side === 'internal' && person.title && title.test(person.title))
    .sort((a, b) => b.emails + b.meetings - (a.emails + a.meetings))[0]?.name ?? null
}

export const CSM_TITLE = /customer success|\bcsm\b/i
export const SE_TITLE = /sales engineer|solutions? (?:engineer|consultant|architect)|pre-?sales/i
export const AE_TITLE = /account executive|\bae\b/i

const pad = (value: number) => String(value).padStart(2, '0')

export function quarterOf(year: number, month: number, fiscalStart: number, role: string): CroQuarter {
  const offset = (month - fiscalStart + 12) % 12
  const startMonth = ((month - 1 - (offset % 3) + 12) % 12) + 1
  const startYear = startMonth > month ? year - 1 : year
  const endMonth = ((startMonth + 1) % 12) + 1
  const endYear = endMonth < startMonth ? startYear + 1 : startYear
  const fiscalYear = (startYear + (fiscalStart > 1 && startMonth >= fiscalStart ? 1 : 0)) % 100
  const number = Math.floor(((startMonth - fiscalStart + 12) % 12) / 3) + 1
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate()
  return {
    key: `FY${pad(fiscalYear)}Q${number}`,
    label: `FY${pad(fiscalYear)} Q${number}`,
    start: `${startYear}-${pad(startMonth)}-01`,
    end: `${endYear}-${pad(endMonth)}-${pad(lastDay)}`,
    role,
  }
}

/** The current and next fiscal quarter for a date, in a year starting in this month and named for the year it ends. */
export function fiscalQuarters(today: string, fiscalStart: number): [CroQuarter, CroQuarter] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const current = quarterOf(year, month, fiscalStart, 'Current')
  const nextStart = current.end.slice(0, 7).split('-').map(Number)
  const nextMonth = nextStart[1] === 12 ? 1 : nextStart[1] + 1
  const nextYear = nextStart[1] === 12 ? nextStart[0] + 1 : nextStart[0]
  return [current, quarterOf(nextYear, nextMonth, fiscalStart, 'Next')]
}

/**
 * Which fiscal calendar the workspace is on, read from its own answers:
 * Backstory says which deals close "this" and "next" quarter but not when those
 * quarters start. Quarters are three months, so only three alignments exist;
 * this is the one that places the most deals where Backstory did. It settles
 * the quarter boundaries, not the fiscal year's name, which is an assumption.
 */
export function inferFiscalStart(today: string, thisQuarter: string[], nextQuarter: string[]): number {
  let best = 1
  let bestFit = -1
  for (const start of [1, 2, 3]) {
    const [current, next] = fiscalQuarters(today, start)
    const within = (dates: string[], quarter: CroQuarter) => dates.filter((date) => date >= quarter.start && date <= quarter.end).length
    const fit = within(thisQuarter, current) + within(nextQuarter, next)
    if (fit > bestFit) {
      best = start
      bestFit = fit
    }
  }
  return best
}
