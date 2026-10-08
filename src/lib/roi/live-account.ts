import { apiLogger } from '@/lib/logger'
import { getPeopleAiClientForUser, getPeopleAiServiceClient, type PeopleAiClient } from '@/lib/peopleai/client'
import { extractMcpText } from '@/lib/peopleai/salesai-facts'
import { resolveNangoConnection } from '@/lib/nango/delivery'
import { withStaleConnectionRecovery } from '@/lib/nango/connection-recovery'
import { NANGO_PROVIDER_TOOLS } from '@/lib/nango/provider-tools'
import { PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-config-keys'
import { loadMcpConnectionPlaneGroups } from '@/features/agents/tool-planes'

/**
 * The account as it stands today, read live from the production Backstory
 * (People.ai Sales AI) and Salesforce connections — what an ROI report can show
 * before an account's warehouse extracts arrive (the Databricks flow), and
 * alongside them after.
 *
 *  - Backstory: the account's open opportunities with their engagement scores,
 *    who is engaged right now (external and internal, by title), and the
 *    account's risks, topics and next steps from the last 30 days.
 *  - Salesforce: the account's closed deals over two years — won and lost, by
 *    type and fiscal year, days to close — and open pipeline by stage.
 *
 * Read with the viewer's own connections (Backstory falls back to the platform's
 * service key), so the result is stored on that person's page only, never on an
 * account's shared report. Every source is best effort: one that is missing or
 * fails is named in `sources` and the rest still fill in.
 */

export type RoiLiveSource = { name: 'Backstory' | 'Salesforce'; ok: boolean; note?: string }

export type RoiLivePerson = { name: string; title: string; emails: number; meetings: number; last: string | null }

export type RoiLiveAccount = {
  fetchedAt: string
  sources: RoiLiveSource[]
  /** 'company' reads the whole business (Backstory's own page); 'account' one customer account. */
  scope?: 'account' | 'company'
  /** The account as Backstory names it. */
  account?: { name: string; domain: string | null }
  opportunities?: Array<{ name: string; type: string | null; amount: number | null; closeDate: string | null; engagement: number | null; owner: string | null }>
  status?: { risks: string[]; topics: string[]; nextSteps: string[] }
  people?: { externalCount: number; internalCount: number; external: RoiLivePerson[]; internal: RoiLivePerson[] }
  salesforce?: {
    closedWon: number
    closedLost: number
    wonAmount: number
    avgDaysToClose: number | null
    byType: Array<{ type: string; won: number; lost: number }>
    byFy: Array<{ fy: string; won: number; lost: number; wonAmount: number }>
    openByStage: Array<{ stage: string; count: number; amount: number }>
  }
}

/** How long a page's live data counts as current before it is read again. */
export const ROI_LIVE_TTL_MS = 6 * 60 * 60_000

const LIVE_TIMEOUT_MS = 12_000

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms))])
}

/** A tool result as data: structured content, else JSON text, else the text itself. */
export function toolData(raw: unknown): unknown {
  const structured = (raw as { structuredContent?: unknown } | null)?.structuredContent
  if (structured && typeof structured === 'object') return (structured as { result?: unknown }).result ?? structured
  const text = extractMcpText(raw)
  if (!text) return raw
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && 'result' in (parsed as object) ? (parsed as { result: unknown }).result : parsed
  } catch {
    return text
  }
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** find_account's answer: the account and its open opportunities. */
export function parseAccount(data: unknown): { id: number; name: string; domain: string | null; opportunities: NonNullable<RoiLiveAccount['opportunities']> } | null {
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  const id = num(row?.peopleai_account_id)
  if (!row || id === null) return null
  const opportunities = (Array.isArray(row.opportunities) ? row.opportunities : []).map((o: Record<string, unknown>) => ({
    name: str(o.opportunity_name) || str(o.name),
    type: str(o.type) || null,
    amount: num(o.amount),
    closeDate: str(o.close_date) || null,
    engagement: num(o.engagement_level),
    owner: str((o.owner as { name?: unknown } | undefined)?.name) || null,
  }))
  return { id, name: str(row.name), domain: str(row.domain) || null, opportunities }
}

/** get_account_status's answer: risks, topics and next steps, one line each. */
export function parseStatus(text: string): RoiLiveAccount['status'] {
  const sections: Record<string, string[]> = { risks: [], topics: [], nextSteps: [] }
  let current: keyof typeof sections | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^risks?\s*:/i.test(line)) { current = 'risks'; continue }
    if (/^(discussed )?topics\s*:/i.test(line)) { current = 'topics'; continue }
    if (/^next steps\s*:/i.test(line)) { current = 'nextSteps'; continue }
    const item = line.replace(/^[-*•]\s*/, '')
    if (current && item) sections[current].push(item.slice(0, 400))
  }
  return { risks: sections.risks.slice(0, 6), topics: sections.topics.slice(0, 6), nextSteps: sections.nextSteps.slice(0, 6) }
}

/** get_engaged_people's answer (an EngagementSummary document): who, by group. */
export function parsePeople(text: string): RoiLiveAccount['people'] {
  const group = (tag: string) => {
    const block = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}>`).exec(text)
    if (!block) return { count: 0, people: [] as RoiLivePerson[] }
    const count = num(/engaged_count="(\d+)"/.exec(block[1])?.[1]) ?? 0
    const people: RoiLivePerson[] = []
    for (const match of block[2].matchAll(/<(?:MostEngagedParticipant|Participant)\s+([^>]*?)\/?>/g)) {
      const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(match[1])?.[1] ?? ''
      people.push({ name: attr('name'), title: attr('job_title'), emails: num(attr('email_count')) ?? 0, meetings: num(attr('meeting_count')) ?? 0, last: attr('last_engaged') || null })
    }
    return { count: Math.max(count, people.length), people: people.filter((p) => p.name).slice(0, 12) }
  }
  const external = group('ExternalGroup')
  const internal = group('InternalGroup')
  return { externalCount: external.count, internalCount: internal.count, external: external.people, internal: internal.people }
}

/** Closed and open opportunities from a SOQL answer, summarised. */
export function summarizeSalesforce(records: Array<Record<string, unknown>>, fyStartMonth: number | null): NonNullable<RoiLiveAccount['salesforce']> {
  const fyOf = (date: string) => {
    const y = Number(date.slice(0, 4))
    const m = Number(date.slice(5, 7))
    const start = fyStartMonth ?? 1
    return `FY${start === 1 ? y : m >= start ? y + 1 : y}`
  }
  let closedWon = 0, closedLost = 0, wonAmount = 0, daySum = 0, dayCount = 0
  const byType = new Map<string, { won: number; lost: number }>()
  const byFy = new Map<string, { won: number; lost: number; wonAmount: number }>()
  const open = new Map<string, { count: number; amount: number }>()
  for (const r of records) {
    const closed = r.IsClosed === true
    const won = r.IsWon === true
    const amount = num(r.Amount) ?? 0
    if (!closed) {
      const stage = str(r.StageName) || 'Open'
      const entry = open.get(stage) ?? { count: 0, amount: 0 }
      open.set(stage, { count: entry.count + 1, amount: entry.amount + amount })
      continue
    }
    if (won) { closedWon += 1; wonAmount += amount } else closedLost += 1
    const type = str(r.Type) || 'Unspecified'
    const t = byType.get(type) ?? { won: 0, lost: 0 }
    byType.set(type, won ? { ...t, won: t.won + 1 } : { ...t, lost: t.lost + 1 })
    const close = str(r.CloseDate)
    if (close) {
      const fy = fyOf(close)
      const f = byFy.get(fy) ?? { won: 0, lost: 0, wonAmount: 0 }
      byFy.set(fy, won ? { ...f, won: f.won + 1, wonAmount: f.wonAmount + amount } : { ...f, lost: f.lost + 1 })
      const created = str(r.CreatedDate)
      if (won && created) {
        const days = (Date.parse(close) - Date.parse(created.slice(0, 10))) / 86_400_000
        if (Number.isFinite(days) && days >= 0) { daySum += days; dayCount += 1 }
      }
    }
  }
  return {
    closedWon,
    closedLost,
    wonAmount,
    avgDaysToClose: dayCount ? Math.round(daySum / dayCount) : null,
    byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.won + b.lost - (a.won + a.lost)),
    byFy: [...byFy.entries()].map(([fy, v]) => ({ fy, ...v })).sort((a, b) => a.fy.localeCompare(b.fy)),
    openByStage: [...open.entries()].map(([stage, v]) => ({ stage, ...v })).sort((a, b) => b.amount - a.amount),
  }
}

const soqlString = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[%_]/g, (c) => `\\${c}`)

/**
 * Backstory through the person's own People.ai connection, else the
 * platform's service key — and the service key again when their own
 * connection has expired, so one stale token never blanks the page.
 */
async function readBackstory(organizationId: string, userId: string, account: string, company: boolean): Promise<Partial<RoiLiveAccount> & { source: RoiLiveSource }> {
  const own = await getPeopleAiClientForUser(userId, organizationId).catch(() => null)
  const clients = [own, getPeopleAiServiceClient()].filter((client): client is PeopleAiClient => Boolean(client))
  if (!clients.length) return { source: { name: 'Backstory', ok: false, note: 'No Backstory connection' } }
  let lastError: unknown = null
  for (const client of clients) {
    try {
      return await readBackstoryWith(client, account, company)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function readBackstoryWith(client: PeopleAiClient, account: string, company: boolean): Promise<Partial<RoiLiveAccount> & { source: RoiLiveSource }> {
  if (company) {
    // The whole business: the open opportunities Backstory ranks most relevant, with their engagement.
    const data = toolData(await client.callTool('top_records', {}))
    const accounts = (Array.isArray(data) ? data : []).map((row) => parseAccount(row)).filter((row): row is NonNullable<ReturnType<typeof parseAccount>> => Boolean(row))
    const opportunities = accounts.flatMap((a) => a.opportunities.map((o) => ({ ...o, name: o.name || a.name })))
    if (!opportunities.length) return { source: { name: 'Backstory', ok: true, note: 'No open opportunities returned' } }
    return { source: { name: 'Backstory', ok: true }, opportunities: opportunities.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 20) }
  }
  const found = parseAccount(toolData(await client.callTool('find_account', { account_name: account })))
  if (!found) return { source: { name: 'Backstory', ok: false, note: `Backstory has no account named ${account}` } }
  const [status, people] = await Promise.all([
    client.callTool('get_account_status', { peopleai_account_id: found.id }).then((raw) => parseStatus(String(toolData(raw) ?? ''))).catch(() => undefined),
    client.callTool('get_engaged_people', { peopleai_account_id: found.id }).then((raw) => parsePeople(String(toolData(raw) ?? ''))).catch(() => undefined),
  ])
  return {
    source: { name: 'Backstory', ok: true },
    account: { name: found.name || account, domain: found.domain },
    opportunities: found.opportunities.slice(0, 20),
    ...(status && (status.risks.length || status.topics.length || status.nextSteps.length) ? { status } : {}),
    ...(people && (people.external.length || people.internal.length) ? { people } : {}),
  }
}

/** Salesforce through the workspace's Nango connection, else a connected Salesforce MCP server's query tool. */
async function readSalesforce(organizationId: string, userId: string, account: string, fyStartMonth: number | null, company: boolean): Promise<{ salesforce?: RoiLiveAccount['salesforce']; source: RoiLiveSource }> {
  const where = company ? '' : `Account.Name LIKE '${soqlString(account)}%' AND `
  const soql = `SELECT Id, StageName, Amount, CloseDate, CreatedDate, Type, IsWon, IsClosed FROM Opportunity WHERE ${where}(CloseDate = LAST_N_MONTHS:24 OR IsClosed = false) ORDER BY CloseDate DESC LIMIT 2000`
  const keys = PROVIDER_CONFIG_KEYS.salesforce
  const connection = await resolveNangoConnection(organizationId, keys, userId).catch(() => null)
  let records: Array<Record<string, unknown>> | null = null
  if (connection) {
    const spec = NANGO_PROVIDER_TOOLS.find((tool) => tool.name === 'salesforce_query')!
    const data = await withStaleConnectionRecovery({ organizationId, providerConfigKeys: keys, userId, connection, call: (c) => spec.run(c, { soql }) }) as { records?: Array<Record<string, unknown>> }
    records = Array.isArray(data?.records) ? data.records : []
  } else {
    const groups = await loadMcpConnectionPlaneGroups(organizationId, userId).catch(() => [])
    const group = groups.find((g) => g.client && /salesforce|sfdc/i.test(`${g.name} ${g.serverUrl}`))
    const tool = group?.tools.find((t) => /soql|query/i.test(t.name))
    if (group?.client && tool) {
      const props = Object.keys(((tool.inputSchema as { properties?: Record<string, unknown> })?.properties) ?? {})
      const param = props.find((p) => /soql/i.test(p)) ?? props.find((p) => /^(q|query)$/i.test(p)) ?? 'query'
      const data = toolData(await group.client.executeTool(group.serverUrl, tool.name, { [param]: soql })) as { records?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
      records = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : []
    }
  }
  if (!records) return { source: { name: 'Salesforce', ok: false, note: 'No Salesforce connection' } }
  if (!records.length) return { source: { name: 'Salesforce', ok: true, note: company ? 'No opportunities in the last two years' : `No opportunities for ${account}` } }
  return { source: { name: 'Salesforce', ok: true }, salesforce: summarizeSalesforce(records, fyStartMonth) }
}

/** Backstory's own page reads the whole business; every other account, itself. */
export const ROI_COMPANY_ACCOUNT = 'Backstory'

/** Read the account live from every source this person can reach. Never throws. */
export async function fetchLiveAccount(params: { organizationId: string; userId: string; account: string; fyStartMonth?: number | null }): Promise<RoiLiveAccount> {
  const company = params.account.trim().toLowerCase() === ROI_COMPANY_ACCOUNT.toLowerCase()
  const failed = (name: RoiLiveSource['name']) => (error: unknown): { source: RoiLiveSource } => {
    apiLogger.warn('roi live account: source failed', { source: name, account: params.account, error: error instanceof Error ? error.message : String(error) })
    return { source: { name, ok: false, note: error instanceof Error ? error.message.slice(0, 160) : 'Unavailable' } }
  }
  const [backstory, salesforce] = await Promise.all([
    within(readBackstory(params.organizationId, params.userId, params.account, company), LIVE_TIMEOUT_MS, 'Backstory').catch(failed('Backstory')),
    within(readSalesforce(params.organizationId, params.userId, params.account, params.fyStartMonth ?? null, company), LIVE_TIMEOUT_MS, 'Salesforce').catch(failed('Salesforce')),
  ])
  const { source: backstorySource, ...fromBackstory } = backstory as Partial<RoiLiveAccount> & { source: RoiLiveSource }
  const { source: salesforceSource, ...fromSalesforce } = salesforce as { salesforce?: RoiLiveAccount['salesforce']; source: RoiLiveSource }
  return { fetchedAt: new Date().toISOString(), sources: [backstorySource, salesforceSource], scope: company ? 'company' : 'account', ...fromBackstory, ...fromSalesforce }
}

const moneyOf = (value: number) => (Math.abs(value) >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : Math.abs(value) >= 1e3 ? `$${Math.round(value / 1e3)}K` : `$${Math.round(value)}`)

/**
 * Findings for a report that has only the live read (an account whose
 * extracts have not arrived): every number from Backstory or Salesforce, as
 * read. The analyst rewrites them when the account's data is built.
 */
export function liveNarrative(live: RoiLiveAccount, account: string): import('./contract').RoiNarrative {
  const sf = live.salesforce
  const closed = sf ? sf.closedWon + sf.closedLost : 0
  const winRate = sf && closed ? (sf.closedWon / closed) * 100 : null
  const opps = live.opportunities ?? []
  const open = opps.reduce((sum, o) => sum + (o.amount ?? 0), 0)
  const scored = opps.filter((o) => o.engagement !== null)
  const high = scored.filter((o) => (o.engagement ?? 0) > 70)
  const highShare = scored.length ? (high.length / scored.length) * 100 : null
  const who = live.scope === 'company' ? 'the business' : account
  const findings: import('./contract').RoiNarrative['findings'] = []
  if (winRate !== null && sf) findings.push({ fig: `${winRate.toFixed(1)}%`, cap: 'win rate, closed deals, last 2 years', h: `${sf.closedWon} deals won of ${closed} closed`, p: `Salesforce shows **${sf.closedWon}** won and **${sf.closedLost}** lost over two years, **${moneyOf(sf.wonAmount)}** closed-won.`, tab: 'deals' })
  if (sf?.avgDaysToClose !== null && sf?.avgDaysToClose !== undefined) findings.push({ fig: `${sf.avgDaysToClose} days`, cap: 'average days to close, won deals', h: 'How long won deals take', p: `Won deals took **${sf.avgDaysToClose}** days on average from creation to close.`, tab: 'deals' })
  if (opps.length) findings.push({ fig: moneyOf(open), cap: 'open pipeline Backstory tracks', h: `${opps.length} open opportunities`, p: `Backstory tracks **${opps.length}** open opportunities worth **${moneyOf(open)}**${highShare !== null ? `; **${highShare.toFixed(0)}%** of them are highly engaged` : ''}.`, tab: 'deals' })
  if (live.people) findings.push({ fig: `${live.people.externalCount}`, cap: 'people engaged, last 30 days', h: `${live.people.externalCount} people engaged at ${account}`, p: `Over the last 30 days, **${live.people.externalCount}** people at ${account} were in email or meetings with **${live.people.internalCount}** on the team.`, tab: 'accounts' })
  while (findings.length < 2) findings.push({ fig: '—', cap: 'more when the data arrives', h: 'Rep activity and adoption arrive with the data flow', p: 'The activity, adoption and stage views fill in when the account\'s warehouse extracts are connected.', tab: 'activity' })
  const risk = live.status?.risks[0]
  const step = live.status?.nextSteps[0]
  return {
    headline: winRate !== null ? `${who === 'the business' ? 'The business' : account} wins ${winRate.toFixed(0)}% of closed deals.` : opps.length ? `${moneyOf(open)} of open pipeline at ${account === ROI_COMPANY_ACCOUNT ? 'Backstory' : account}.` : `${account} today, live from Backstory.`,
    lede: `Read live from ${live.sources.filter((s) => s.ok).map((s) => s.name).join(' and ') || 'Backstory'} until ${account}'s warehouse extracts arrive; rep activity, adoption and stage views fill in then.`,
    findings: findings.slice(0, 6),
    watch: [
      ...(risk ? [{ lead: 'Risk.', text: risk }] : []),
      ...(step ? [{ lead: 'Next step.', text: step }] : []),
      { lead: 'Live, not yet analysed.', text: 'These numbers are read as they stand; the analysis of engagement against outcomes needs the warehouse extracts.' },
      { lead: 'Your own connections.', text: 'Read with your Backstory and Salesforce access, so it shows on your page only.' },
    ].slice(0, 6),
    notes: {},
    caveats: live.sources.filter((s) => !s.ok).map((s) => `${s.name} could not be read: ${s.note ?? 'unavailable'}.`),
  }
}

/** Whether a page's live data has anything to show. */
export function hasLiveData(live: RoiLiveAccount | null | undefined): boolean {
  return Boolean(live && (live.opportunities?.length || live.status || live.people || live.salesforce))
}
