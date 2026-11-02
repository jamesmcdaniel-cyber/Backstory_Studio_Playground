import { prisma } from '@/lib/prisma'
import { deleteStoredFile, readStoredFile, saveStoredFile } from '@/lib/files/storage'
import { addVersion, createArtifact } from '@/lib/artifacts/service'
import { ArtifactValidatorUnavailableError } from '@/lib/artifacts/preflight'
import { ArtifactContentError } from '@/lib/artifacts/validate-content'
import { generateStructured } from '@/lib/llm/model-runner'
import { mapConcurrent } from '@/lib/map-concurrent'
import { dealTypeOf, fiscalQuarters, inferFiscalStart, isoDate, parseAccountOpportunities, parseOpenDeals, quarterOf, type AccountOpportunity, type OpenDeal } from './pipeline'
import { renderCroDashboard, type CroDashboardData, type CroDeal, type CroQuarter } from './schema'
import { scoreBatch, type BackstoryCaller, type StructuredGenerator } from './score'

/**
 * The CRO dashboard plane. The agent drives three steps and the platform does
 * the work, because a model cannot relay a whole portfolio: 261 deals on the
 * demo tenant is over 500 Backstory calls and far more text than one run's
 * context holds. The draft between steps is a workspace file, so a run that
 * stops partway loses nothing and the model only ever passes its id.
 *
 * Read-only on the outside: Backstory is only read, and the page is saved as a
 * new artifact version, so nothing is overwritten.
 */

export const CRO_DASHBOARD_TITLE = 'CRO Pipeline Health'
/** What the plane calls on the Backstory MCP; a connection missing any of these cannot build the page. */
export const CRO_BACKSTORY_TOOLS = ['fetch_records', 'find_account', 'get_opportunity_status', 'get_opportunity_engaged_people', 'situation_search']

const DRAFT_PREFIX = 'cro-dashboard-draft-'
/** Deals past this, smallest amounts first, stay on the page as pipeline-only rows: it keeps the run and the page a bounded size. */
export const CRO_MAX_ANALYZED_DEALS = 300
const BATCH_SIZE = 12
const PARALLEL_BATCHES = 3
const ENRICH_CONCURRENCY = 6
const MAX_ATTEMPTS = 2
const MAX_EXTRA_QUARTERS = 4
/** No new round starts after this, so one tool call stays bounded; the agent calls again. */
const SCORE_BUDGET_MS = 150_000

export const CRO_TOOLS = [
  {
    name: 'cro_start_dashboard',
    description:
      'Step 1 of building the CRO dashboard. Pulls every open deal closing in the current and next fiscal quarter from Backstory, with amounts, stages, owners and deal types, and saves a draft. Returns its draftId and the pipeline totals. Call it once per build. Pass extraQuarters only when asked to include further quarters.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        fiscalYearStartMonth: { type: 'integer', minimum: 1, maximum: 12, description: 'The month the fiscal year starts, only if the person named it. Otherwise the quarters are worked out from Backstory.' },
        extraQuarters: {
          type: 'array',
          description: `Further quarters to include, up to ${MAX_EXTRA_QUARTERS}, by their dates.`,
          items: { type: 'object', properties: { start: { type: 'string', description: 'YYYY-MM-DD' }, end: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['start', 'end'] },
        },
      },
    },
  },
  {
    name: 'cro_score_deals',
    description:
      'Step 2. Gathers Backstory evidence for the next deals in the draft, classifies them against the dashboard rubric, finds past situations and writes recommendations. Handles as many as fit in a few minutes and returns the newest draftId with counts. Call it again with that newest draftId until it reports done: true. If it returns an error, stop and report it.',
    isWrite: false,
    inputSchema: { type: 'object', properties: { draftId: { type: 'string', description: 'The newest draftId.' } }, required: ['draftId'] },
  },
  {
    name: 'cro_publish_dashboard',
    description:
      'Step 3. Builds the fixed dashboard page from the finished draft and saves it as this agent\'s artifact, as a new version when one already exists so the link stays the same. Returns the link, the totals and what limited the run. Report those; do not write the page yourself.',
    isWrite: false,
    inputSchema: { type: 'object', properties: { draftId: { type: 'string', description: 'The newest draftId.' } }, required: ['draftId'] },
  },
] satisfies ReadonlyArray<{ name: string; description: string; isWrite: boolean; inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }>

type DraftDeal = CroDeal & { accountId: string; typeInferred: boolean; pending: boolean; attempts: number; failed?: boolean }

type CroDraft = {
  kind: 'cro-dashboard-draft'
  today: string
  builtAt: string
  seller: string
  fiscalYearStartMonth: number
  fiscalInferred: boolean
  quarters: CroQuarter[]
  deals: DraftDeal[]
  engagedFailures: number
  truncatedQueries: number
}

export type CroPublishContext = { artifactId: string; executionId: string; expectedVersionId?: string }

export type CroToolDeps = {
  /** The workspace's Backstory MCP, resolved per the acting user. */
  backstory: () => Promise<BackstoryCaller>
  generate?: StructuredGenerator
  now?: () => Date
  /** Set for a run started from the dashboard's own conversation: that artifact gets the new version. */
  artifact?: CroPublishContext
  executionId?: string
}

/** Largest first, so the limit drops the smallest deals; grouped by account afterwards when batched. */
export function dealsToAnalyze<T extends { amt: number | null }>(deals: T[], limit: number): T[] {
  return [...deals].sort((a, b) => (b.amt ?? 0) - (a.amt ?? 0)).slice(0, limit)
}

/** The next batch: an account's deals stay together, so its evidence is read once and consistently. */
export function nextBatch(deals: DraftDeal[], size: number, taken: Set<string>): DraftDeal[] {
  const pending = deals.filter((deal) => deal.pending && !taken.has(deal.id)).sort((a, b) => a.accountId.localeCompare(b.accountId) || (b.amt ?? 0) - (a.amt ?? 0))
  const batch: DraftDeal[] = []
  for (const deal of pending) {
    if (batch.length >= size && batch[batch.length - 1].accountId !== deal.accountId) break
    batch.push(deal)
  }
  return batch
}

const money = (amount: number) => `$${Math.round(amount).toLocaleString('en-US')}`
const sumAmount = (deals: Array<{ amt: number | null }>) => deals.reduce((total, deal) => total + (deal.amt ?? 0), 0)

function tally(deals: DraftDeal[]) {
  const by = (match: (deal: DraftDeal) => boolean) => {
    const matched = deals.filter(match)
    return { deals: matched.length, amount: money(sumAmount(matched)) }
  }
  return {
    onTrack: by((deal) => deal.status === 'on_track'),
    slipping: by((deal) => deal.status === 'not_on_track' && deal.severity === 'slipping'),
    atRisk: by((deal) => deal.status === 'not_on_track' && deal.severity === 'at_risk'),
    notAnalyzed: by((deal) => deal.status === 'unanalyzed' && !deal.pending),
  }
}

/** The page's header notes. Fixed wording and counts only: the page shows these as HTML. */
export function croNotes(draft: CroDraft): string[] {
  const inferred = draft.deals.filter((deal) => deal.typeInferred).length
  const overLimit = draft.deals.filter((deal) => deal.status === 'unanalyzed' && !deal.failed).length
  const failed = draft.deals.filter((deal) => deal.failed).length
  return [
    '<b>Open deals only.</b> Backstory does not expose Account Health, so deals on Black-health accounts could not be excluded.',
    '<b>Source:</b> the Backstory MCP alone. Slack, Jira and calendar meetings are not part of this view.',
    '<b>Tier:</b> Backstory does not expose account tier, so every deal shows as Unassigned and ranks by status and amount.',
    '<b>CSM and SE:</b> the people with those titles engaged on the deal in the last 30 days.',
    `<b>Fiscal quarters:</b> ${draft.fiscalInferred ? `boundaries worked out from Backstory; the year's name assumes it starts in month ${draft.fiscalYearStartMonth}` : `the fiscal year starts in month ${draft.fiscalYearStartMonth}`}.`,
    ...(inferred ? [`<b>Deal type:</b> ${inferred} deal${inferred === 1 ? '' : 's'} had no type in Backstory, so it was read from the opportunity name.`] : []),
    ...(overLimit ? [`<b>Analysis limit:</b> the largest ${CRO_MAX_ANALYZED_DEALS} deals were analyzed; ${overLimit} smaller ones have pipeline data only.`] : []),
    ...(failed ? [`<b>Not scored:</b> ${failed} deal${failed === 1 ? '' : 's'} could not be scored because evidence or scoring failed. They are not counted as on track or at risk.`] : []),
    ...(draft.engagedFailures ? [`<b>Engaged people:</b> unavailable for ${draft.engagedFailures} deal${draft.engagedFailures === 1 ? '' : 's'}, so stakeholders there are named from their status text.`] : []),
    ...(draft.truncatedQueries ? ['<b>Pipeline cap:</b> Backstory returned its 1,000-record maximum for a quarter, so that quarter may be incomplete.'] : []),
    '<b>Amounts:</b> as recorded in Backstory; $0 and blank are shown as-is.',
  ]
}

export class CroToolClient {
  private readonly generate: StructuredGenerator
  private readonly now: () => Date

  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly agentId: string | null,
    private readonly deps: CroToolDeps,
  ) {
    this.generate = deps.generate ?? generateStructured
    this.now = deps.now ?? (() => new Date())
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      if (name === 'cro_start_dashboard') return await this.start(args)
      if (name === 'cro_score_deals') return await this.score(args)
      if (name === 'cro_publish_dashboard') return await this.publish(args)
      throw new Error(`Unknown CRO dashboard tool "${name}".`)
    } catch (error) {
      // The validator being down says nothing about the page: keep the draft and retry.
      if (error instanceof ArtifactValidatorUnavailableError) {
        return { error: error.message, retryable: true, note: 'This is a platform outage, not a problem with the data. Tell the person the page could not be saved right now, and to retry in a minute.' }
      }
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async start(args: Record<string, unknown>) {
    const backstory = await this.deps.backstory()
    const now = this.now()
    const today = now.toISOString().slice(0, 10)
    const extra = (Array.isArray(args.extraQuarters) ? args.extraQuarters : []).slice(0, MAX_EXTRA_QUARTERS).flatMap((item) => {
      const start = isoDate((item as { start?: unknown }).start)
      const end = isoDate((item as { end?: unknown }).end)
      return start && end && start <= end ? [{ start, end }] : []
    })
    // One query per quarter: asked for "this or next" together, Backstory's
    // reader applies both windows at once and matches nothing.
    const fetchQuery = async (query: string) => parseOpenDeals(await backstory('fetch_records', { object_type: 'opportunity', query }))
    const [current, next, ...added] = await Promise.all([
      fetchQuery('open opportunities closing this fiscal quarter'),
      fetchQuery('open opportunities closing next fiscal quarter'),
      ...extra.map((range) => fetchQuery(`open opportunities with a close date from ${range.start} to ${range.end}`)),
    ])
    const named = typeof args.fiscalYearStartMonth === 'number' && args.fiscalYearStartMonth >= 1 && args.fiscalYearStartMonth <= 12 ? Math.round(args.fiscalYearStartMonth) : null
    const fiscalStart = named ?? inferFiscalStart(today, current.deals.map((deal) => deal.close), next.deals.map((deal) => deal.close))
    const [currentQuarter, nextQuarter] = fiscalQuarters(today, fiscalStart)
    const addedQuarters = extra.map((range) => {
      const quarter = quarterOf(Number(range.start.slice(0, 4)), Number(range.start.slice(5, 7)), fiscalStart, 'Added')
      return { ...quarter, start: range.start, end: range.end }
    })

    const opportunityOf = await this.ownersAndTypes(backstory, [...current.deals, ...next.deals, ...added.flatMap((result) => result.deals)])
    const seen = new Set<string>()
    const rows: DraftDeal[] = []
    const addRows = (deals: OpenDeal[], quarter: CroQuarter) => {
      for (const deal of deals) {
        if (seen.has(deal.id)) continue
        seen.add(deal.id)
        const known = opportunityOf.get(deal.id)
        const { dtype, inferred } = dealTypeOf(known?.type ?? null, deal.name)
        rows.push({
          id: deal.id, name: deal.name, acct: deal.account, accountId: deal.accountId, tier: null, csm: null, se: null,
          owner: known?.owner ?? null, dtype, typeInferred: inferred, stage: deal.stage || 'Unknown', amt: deal.amount, close: deal.close, q: quarter.key,
          status: 'unanalyzed', pending: false, attempts: 0,
        })
      }
    }
    addRows(current.deals, currentQuarter)
    addRows(next.deals, nextQuarter)
    added.forEach((result, index) => addRows(result.deals, addedQuarters[index]))
    const analyzed = new Set(dealsToAnalyze(rows, CRO_MAX_ANALYZED_DEALS).map((deal) => deal.id))
    for (const row of rows) row.pending = analyzed.has(row.id)

    const draft: CroDraft = {
      kind: 'cro-dashboard-draft',
      today,
      builtAt: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      seller: '',
      fiscalYearStartMonth: fiscalStart,
      fiscalInferred: named === null,
      quarters: [currentQuarter, nextQuarter, ...addedQuarters],
      deals: rows,
      engagedFailures: 0,
      truncatedQueries: [current, next, ...added].filter((result) => result.total > result.deals.length).length,
    }
    const draftId = await this.saveDraft(draft)
    return {
      draftId,
      quarters: draft.quarters.map((quarter) => ({ label: quarter.label, start: quarter.start, end: quarter.end, deals: rows.filter((deal) => deal.q === quarter.key).length })),
      deals: rows.length,
      totalAmount: money(sumAmount(rows)),
      toAnalyze: analyzed.size,
      next: rows.length ? 'Call cro_score_deals with this draftId.' : 'No open deals in scope. Call cro_publish_dashboard, or report that.',
    }
  }

  private async ownersAndTypes(backstory: BackstoryCaller, deals: OpenDeal[]): Promise<Map<string, AccountOpportunity>> {
    const accounts = new Map(deals.map((deal) => [deal.accountId, deal.account]))
    const found = new Map<string, AccountOpportunity>()
    await mapConcurrent([...accounts.entries()], ENRICH_CONCURRENCY, async ([accountId, account]) => {
      // A failed lookup leaves the owner blank and the type read from the name, and the page says so.
      const raw = await backstory('find_account', { account_name: account }).catch(() => null)
      for (const [id, opportunity] of parseAccountOpportunities(raw, accountId)) found.set(id, opportunity)
    })
    return found
  }

  private async score(args: Record<string, unknown>) {
    const { draft, id } = await this.readDraft(args)
    const backstory = await this.deps.backstory()
    const started = this.now().getTime()
    const quarterEnd = new Map(draft.quarters.map((quarter) => [quarter.key, quarter.end]))
    const ledger = { organizationId: this.organizationId, userId: this.userId || null, agentExecutionId: this.deps.artifact?.executionId ?? this.deps.executionId ?? null }
    let scoredNow = 0
    let currentId = id
    let outage: string | null = null

    while (draft.deals.some((deal) => deal.pending) && this.now().getTime() - started < SCORE_BUDGET_MS) {
      const taken = new Set<string>()
      const batches: DraftDeal[][] = []
      for (let index = 0; index < PARALLEL_BATCHES; index += 1) {
        const batch = nextBatch(draft.deals, BATCH_SIZE, taken)
        if (!batch.length) break
        batch.forEach((deal) => taken.add(deal.id))
        batches.push(batch)
      }
      const results = await Promise.all(batches.map((batch) => scoreBatch(batch, {
        backstory,
        generate: this.generate,
        ledger,
        today: draft.today,
        quarterEndOf: (q) => quarterEnd.get(q) ?? '',
      })))

      const roundScored = results.reduce((total, result) => total + result.scored.length, 0)
      // Nothing came back for deals that had not failed before: an outage, not
      // a verdict on them, so they stay pending for a retry. A round of only
      // retries is different: those deals keep failing on their own.
      if (!roundScored && batches.flat().some((deal) => deal.attempts === 0)) {
        outage = results.find((result) => result.firstError)?.firstError ?? 'No deal could be scored.'
        break
      }
      const byId = new Map(draft.deals.map((deal) => [deal.id, deal]))
      for (const result of results) {
        draft.seller ||= result.seller
        draft.engagedFailures += result.engagedFailures
        for (const scored of result.scored) {
          const row = byId.get(scored.id)
          if (row) Object.assign(row, scored, { pending: false })
        }
        for (const failedId of result.failed) {
          const row = byId.get(failedId)
          if (!row) continue
          row.attempts += 1
          if (row.attempts >= MAX_ATTEMPTS) Object.assign(row, { pending: false, failed: true })
        }
      }
      scoredNow += roundScored
      // Saved after every round, so a stopped run resumes from here.
      currentId = await this.replaceDraft(draft, currentId)
    }

    const remaining = draft.deals.filter((deal) => deal.pending).length
    if (outage) {
      return { error: `Scoring stopped: ${outage}`, draftId: currentId, remaining, scoredThisCall: scoredNow, note: 'Stop and report this. Nothing is lost: the draft keeps what was scored, and the same call can resume it.' }
    }
    return {
      draftId: currentId,
      done: remaining === 0,
      scoredThisCall: scoredNow,
      remaining,
      ...tally(draft.deals),
      next: remaining ? 'Call cro_score_deals again with this newest draftId.' : 'Call cro_publish_dashboard with this newest draftId.',
    }
  }

  private async publish(args: Record<string, unknown>) {
    const { draft, id } = await this.readDraft(args)
    const remaining = draft.deals.filter((deal) => deal.pending).length
    if (remaining) return { error: `${remaining} deals are not scored yet. Call cro_score_deals until it reports done, then publish.`, draftId: id }

    const data: CroDashboardData = {
      today: draft.today,
      builtAt: draft.builtAt,
      seller: draft.seller,
      fiscalYearStartMonth: draft.fiscalYearStartMonth,
      quarters: draft.quarters,
      notes: croNotes(draft),
      // Only what the page reads: the draft's bookkeeping stays out of it.
      deals: draft.deals.map(({ accountId: _accountId, typeInferred: _typeInferred, pending: _pending, attempts: _attempts, failed: _failed, ...deal }) => deal),
    }
    const content = renderCroDashboard(data)
    const saved = await this.save(content)
    // The page holds everything now. A leftover draft is only quota.
    await deleteStoredFile(id, this.organizationId).catch(() => false)
    const counts = tally(draft.deals)
    const failed = draft.deals.filter((deal) => deal.failed).length
    return {
      ...saved,
      title: CRO_DASHBOARD_TITLE,
      quarters: draft.quarters.map((quarter) => quarter.label),
      deals: draft.deals.length,
      totalAmount: money(sumAmount(draft.deals)),
      ...counts,
      limits: [
        'Black-health accounts could not be excluded: Backstory does not expose account health.',
        'Account tier is unavailable from Backstory, so every deal shows as Unassigned.',
        'Slack, Jira and calendar meetings are not part of this view.',
        ...(failed ? [`${failed} deal${failed === 1 ? '' : 's'} could not be scored and ${failed === 1 ? 'is' : 'are'} shown as not analyzed.`] : []),
        ...(draft.truncatedQueries ? ['Backstory returned its 1,000-record maximum for a quarter, so that quarter may be incomplete.'] : []),
      ],
    }
  }

  private async save(content: string): Promise<{ link: string; version: number; newArtifact: boolean }> {
    const context = this.deps.artifact
    const target = context
      ? await prisma.artifact.findFirst({ where: { id: context.artifactId, organizationId: this.organizationId }, select: { id: true, currentVersionId: true } })
      : this.agentId
        ? await prisma.artifact.findFirst({
            where: { organizationId: this.organizationId, agentTaskId: this.agentId, title: CRO_DASHBOARD_TITLE, archivedAt: null, templateSourceId: null },
            orderBy: { createdAt: 'desc' },
            select: { id: true, currentVersionId: true },
          })
        : null
    const executionId = context?.executionId ?? this.deps.executionId ?? null
    try {
      if (target) {
        const version = await addVersion({
          artifactId: target.id,
          organizationId: this.organizationId,
          content,
          executionId,
          request: 'Refreshed the CRO dashboard',
          createdByUserId: this.userId || null,
          // Platform-rendered, not agent-written: there are no authored tests to require.
          declaredTests: false,
          ...(context?.expectedVersionId ? { expectedVersionId: context.expectedVersionId } : {}),
        })
        if (context) context.expectedVersionId = version.id
        return { link: `/artifacts/${target.id}`, version: version.number, newArtifact: false }
      }
      const { artifact, version } = await createArtifact({
        organizationId: this.organizationId,
        userId: this.userId || null,
        kind: 'page',
        title: CRO_DASHBOARD_TITLE,
        content,
        agentTaskId: this.agentId,
        executionId,
        declaredTests: false,
      })
      return { link: `/artifacts/${artifact.id}`, version: version.number, newArtifact: true }
    } catch (error) {
      if (error instanceof ArtifactContentError) throw new Error(`The page could not be saved: ${error.message}`)
      throw error
    }
  }

  private async readDraft(args: Record<string, unknown>): Promise<{ draft: CroDraft; id: string }> {
    const id = typeof args.draftId === 'string' ? args.draftId : ''
    if (!id) throw new Error('Pass the newest draftId.')
    const stored = await readStoredFile(id, this.organizationId)
    if (!stored || !stored.filename.startsWith(DRAFT_PREFIX)) throw new Error('That draft was not found. Start again with cro_start_dashboard.')
    const draft = JSON.parse(stored.buffer.toString('utf8')) as CroDraft
    if (draft.kind !== 'cro-dashboard-draft') throw new Error('That file is not a dashboard draft.')
    return { draft, id }
  }

  private async saveDraft(draft: CroDraft): Promise<string> {
    const saved = await saveStoredFile({
      organizationId: this.organizationId,
      userId: this.userId || null,
      filename: `${DRAFT_PREFIX}${this.now().getTime()}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(draft)),
      // Computed here from Backstory's answers.
      trusted: true,
    })
    return saved.id
  }

  private async replaceDraft(draft: CroDraft, previousId: string): Promise<string> {
    const id = await this.saveDraft(draft)
    await deleteStoredFile(previousId, this.organizationId).catch(() => false)
    return id
  }
}
