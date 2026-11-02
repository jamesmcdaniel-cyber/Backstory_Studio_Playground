import { z } from 'zod'
import { generateStructured, type LedgerContext } from '@/lib/llm/model-runner'
import { mapConcurrent } from '@/lib/map-concurrent'
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { CRO_CLASSIFICATION_RUBRIC, CRO_RECOMMENDATION_RUBRIC } from './rubric'
import { AE_TITLE, CSM_TITLE, internalWithTitle, mcpPayload, mcpText, parseEngagedPeople, SE_TITLE, type EngagedPerson } from './pipeline'
import { CRO_REASONS, type CroAction, type CroDeal, type CroEngage, type CroReason } from './schema'

/**
 * Scoring one batch of deals: evidence from Backstory, the rubric's labels
 * from a model, situation_search on the deals not on track, then
 * recommendations from a model. The model only ever writes the labels and the
 * prose; everything it names is checked against what Backstory returned, so a
 * person it made up becomes a "role to identify" and a tool failure is never
 * read as a quiet deal.
 */

export const CRO_SCORING_MODEL = 'claude-sonnet-5-5'
const EVIDENCE_CONCURRENCY = 6
const STATUS_MAX_CHARS = 6_000
const MAX_PEOPLE_PER_SIDE = 12
const MAX_ANALOGUES = 3

export type BackstoryCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>
export type StructuredGenerator = typeof generateStructured
export type ScoringDeps = { backstory: BackstoryCaller; generate: StructuredGenerator; ledger: LedgerContext; today: string; quarterEndOf: (q: string) => string }

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g
/** Page text: no Markdown emphasis, no email addresses, bounded. */
const plain = (text: unknown, max: number) => (typeof text === 'string' ? text : '').replace(/\*\*/g, '').replace(EMAIL, '').replace(/\s+/g, ' ').trim().slice(0, max)

const reasonEnum = z.enum(CRO_REASONS)
const classificationSchema = z.object({
  id: z.string(),
  status: z.enum(['on_track', 'not_on_track']),
  severity: z.enum(['slipping', 'at_risk']).nullish(),
  reason: reasonEnum.nullish(),
  secondary: z.array(reasonEnum).nullish(),
  outcome: z.string().min(1),
  evidence: z.string().min(1),
  onTrackNote: z.string().nullish(),
  backstoryRisks: z.array(z.string()).nullish(),
  recordedNextStep: z.string().nullish(),
  blocker: z.string().nullish(),
})
type Classification = z.infer<typeof classificationSchema>

const nullableString = { type: ['string', 'null'] }
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    deals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['on_track', 'not_on_track'] },
          severity: { type: ['string', 'null'], enum: ['slipping', 'at_risk', null] },
          reason: { type: ['string', 'null'], enum: [...CRO_REASONS, null] },
          secondary: { type: 'array', items: { type: 'string', enum: [...CRO_REASONS] } },
          outcome: { type: 'string', description: 'A short likely-outcome phrase, never a probability.' },
          evidence: { type: 'string', description: '1 to 2 sentences citing what Backstory shows.' },
          onTrackNote: { ...nullableString, description: 'One line of confirming evidence, on-track deals only.' },
          backstoryRisks: { type: 'array', items: { type: 'string' }, description: 'The open risks Backstory lists, in plain text.' },
          recordedNextStep: { ...nullableString, description: 'The next step Backstory records, in plain text.' },
          blocker: { ...nullableString, description: 'Not on track only: the concrete blocker in under 15 words, with no company or person names.' },
        },
        required: ['id', 'status', 'outcome', 'evidence'],
      },
    },
  },
  required: ['deals'],
}

const engageSchema = z.object({ name: z.string().min(1), role: z.string().nullish(), status: z.string().nullish(), why: z.string().nullish() })
const actionSchema = z.object({ action: z.string().min(1), owner: z.string().min(1), by: z.string().min(1), unblocks: z.string().min(1), source: z.string().nullish(), engage: z.array(engageSchema).nullish() })
const recommendationSchema = z.object({ id: z.string(), customerActions: z.array(actionSchema).nullish(), internalActions: z.array(actionSchema).nullish() })
type RawAction = z.infer<typeof actionSchema>

const ACTION_ITEMS = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    owner: { type: 'string' },
    by: { type: 'string' },
    unblocks: { type: 'string' },
    source: { type: 'string' },
    engage: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A person given to you, or the needed role when none fits.' },
          role: { type: 'string', description: 'Champion, Economic buyer, Exec sponsor, Technical lead, Procurement/Legal, AE, CSM, SE, or similar.' },
          status: { type: 'string', enum: ['named', 'to_identify'] },
          why: { type: 'string', description: 'Under 140 characters, tied to this step.' },
        },
        required: ['name', 'role', 'status', 'why'],
      },
    },
  },
  required: ['action', 'owner', 'by', 'unblocks', 'source', 'engage'],
}
const RECOMMEND_SCHEMA = {
  type: 'object',
  properties: {
    deals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, customerActions: { type: 'array', items: ACTION_ITEMS }, internalActions: { type: 'array', items: ACTION_ITEMS } },
        required: ['id', 'customerActions', 'internalActions'],
      },
    },
  },
  required: ['deals'],
}

type Analogue = { summary: string; actions: string[]; outcome: string; result: 'won' | 'lost' | 'open' }

/** The usable past situations in a situation_search answer, with the other customers' names left behind. */
export function parseAnalogues(raw: unknown): Analogue[] {
  const candidates = (mcpPayload(raw) as { candidates?: unknown } | null)?.candidates
  if (!Array.isArray(candidates)) return []
  return (candidates as Array<Record<string, unknown>>).slice(0, MAX_ANALOGUES).map((candidate) => ({
    summary: plain(candidate.situation_summary, 500),
    actions: (Array.isArray(candidate.actions_taken) ? candidate.actions_taken : []).slice(0, 5).map((action) => plain(action, 240)),
    outcome: plain(candidate.outcome, 400),
    result: candidate.opportunity_is_closed === true ? (candidate.opportunity_is_won === true ? 'won' : 'lost') : 'open',
  }))
}

/** Who to engage, held to the people Backstory returned and to the side that has to act. */
export function normalizeEngage(raw: RawAction['engage'], side: CroEngage['side'], people: EngagedPerson[], statusText: string): CroEngage[] {
  const engage: CroEngage[] = []
  for (const entry of raw ?? []) {
    const name = plain(entry.name, 80)
    const role = plain(entry.role, 40) || 'Stakeholder'
    const why = plain(entry.why, 140)
    const known = people.find((person) => person.name.toLowerCase() === name.toLowerCase())
    if (known) {
      // Someone from the other side does not belong on this step.
      if (known.side === side) engage.push({ name: known.name, title: known.title, side, role, status: 'engaged', why })
      continue
    }
    if (entry.status !== 'to_identify' && name && statusText.toLowerCase().includes(name.toLowerCase())) {
      engage.push({ name, title: null, side, role, status: 'not_engaged', why })
    } else {
      engage.push({ name: entry.status === 'to_identify' && name ? name : `${role} to identify`, title: null, side, role, status: 'to_identify', why })
    }
  }
  if (!engage.length) engage.push({ name: 'Stakeholder to identify', title: null, side, role: 'Stakeholder', status: 'to_identify', why: 'No one in Backstory fits this step yet.' })
  return engage.slice(0, 3)
}

function normalizeActions(raw: RawAction[] | null | undefined, side: CroEngage['side'], people: EngagedPerson[], statusText: string, hasAnalogues: boolean): CroAction[] {
  return (raw ?? []).slice(0, 3).map((action) => ({
    action: plain(action.action, 260),
    owner: plain(action.owner, 80),
    by: plain(action.by, 60),
    unblocks: plain(action.unblocks, 80),
    // Without an analogue there is nothing to cite, whatever the model wrote.
    source: hasAnalogues && plain(action.source, 320) ? plain(action.source, 320) : 'rubric-based',
    engage: normalizeEngage(action.engage, side, people, statusText),
  }))
}

const parseDeals = <T>(raw: string, schema: z.ZodType<T>): T[] => {
  const deals = (JSON.parse(raw) as { deals?: unknown }).deals
  return (Array.isArray(deals) ? deals : []).flatMap((deal) => {
    const parsed = schema.safeParse(deal)
    return parsed.success ? [parsed.data] : []
  })
}

type Gathered = { deal: CroDeal; status: string; people: EngagedPerson[]; seller: string; engagedFailed: boolean }

/** A situation query with no customer or person names in it. */
export function situationQuery(deal: CroDeal, blocker: string, people: EngagedPerson[]): string {
  let cleaned = plain(blocker, 160)
  for (const name of [deal.acct, deal.name, ...people.map((person) => person.name)]) {
    if (name) cleaned = cleaned.split(name).join('the party')
  }
  return [deal.reason, cleaned, `${deal.stage} stage`, deal.dtype].filter(Boolean).join(', ')
}

export type BatchResult = { scored: CroDeal[]; failed: string[]; firstError: string | null; seller: string; engagedFailures: number }

export async function scoreBatch(batch: CroDeal[], deps: ScoringDeps): Promise<BatchResult> {
  const failed = new Set<string>()
  let firstError: string | null = null
  const fail = (id: string, error: unknown) => {
    failed.add(id)
    firstError ??= error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
  }

  const gathered = (await mapConcurrent(batch, EVIDENCE_CONCURRENCY, async (deal): Promise<Gathered | null> => {
    const id = Number(deal.id)
    const [status, engaged] = await Promise.allSettled([
      deps.backstory('get_opportunity_status', { peopleai_opportunity_id: id }),
      deps.backstory('get_opportunity_engaged_people', { peopleai_opportunity_id: id }),
    ])
    // No status means no evidence, which is not the same as a quiet deal.
    if (status.status === 'rejected') {
      fail(deal.id, status.reason)
      return null
    }
    const parsed = engaged.status === 'fulfilled' ? parseEngagedPeople(engaged.value) : { people: [], seller: '' }
    return { deal, status: mcpText(status.value).slice(0, STATUS_MAX_CHARS), people: parsed.people, seller: parsed.seller, engagedFailed: engaged.status === 'rejected' }
  })).filter((item): item is Gathered => Boolean(item))

  const classifications = new Map<string, Classification>()
  if (gathered.length) {
    try {
      const raw = await deps.generate({
        schemaName: 'cro_deal_classification',
        schema: CLASSIFY_SCHEMA,
        model: CRO_SCORING_MODEL,
        maxTokens: 8_000,
        ledger: deps.ledger,
        system: `You classify open sales deals for a CRO's pipeline dashboard, following this rubric exactly. Today is ${deps.today}. Backstory is the only evidence source. Return one entry per deal, with its id unchanged. Write plain text with no Markdown. Never invent a fact.\n\n${CRO_CLASSIFICATION_RUBRIC}\n\n${UNTRUSTED_DATA_RULE}`,
        user: fenceUntrusted('Backstory evidence for each deal', JSON.stringify(gathered.map(({ deal, status, people }) => ({
          id: deal.id,
          opportunity: deal.name,
          account: deal.acct,
          type: deal.dtype,
          stage: deal.stage,
          amount: deal.amt,
          closeDate: deal.close,
          closeDateHasPassed: deal.close < deps.today,
          quarterEnds: deps.quarterEndOf(deal.q),
          backstoryStatusLast30Days: status,
          peopleEngagedLast30Days: { customer: people.filter((person) => person.side === 'customer').length, ours: people.filter((person) => person.side === 'internal').length },
        })))),
      })
      for (const item of parseDeals(raw, classificationSchema)) classifications.set(item.id, item)
    } catch (error) {
      gathered.forEach(({ deal }) => fail(deal.id, error))
    }
  }

  const labelled: Array<Gathered & { blocker: string }> = []
  for (const item of gathered) {
    const label = classifications.get(item.deal.id)
    if (!label) {
      if (!failed.has(item.deal.id)) fail(item.deal.id, new Error('The scoring model returned no valid label for this deal.'))
      continue
    }
    const applied = applyLabel(item.deal, label, deps.today)
    if (!applied) {
      fail(item.deal.id, new Error('The scoring model left a deal not on track without a severity or reason.'))
      continue
    }
    labelled.push({ ...item, deal: applied, blocker: plain(label.blocker, 160) })
  }

  const notOnTrack = labelled.filter((item) => item.deal.status === 'not_on_track')
  const searched = await mapConcurrent(notOnTrack, EVIDENCE_CONCURRENCY, async (item) => {
    try {
      const raw = await deps.backstory('situation_search', { query: situationQuery(item.deal, item.blocker, item.people), object_type: 'opportunity', peopleai_object_id: Number(item.deal.id) })
      return { id: item.deal.id, analogues: parseAnalogues(raw), note: '' }
    } catch {
      return { id: item.deal.id, analogues: [] as Analogue[], note: 'Situation search was unavailable for this deal, so these steps are rubric-based.' }
    }
  })
  const searchOf = new Map(searched.map((result) => [result.id, result]))

  const recommendations = new Map<string, z.infer<typeof recommendationSchema>>()
  if (notOnTrack.length) {
    try {
      const raw = await deps.generate({
        schemaName: 'cro_deal_recommendations',
        schema: RECOMMEND_SCHEMA,
        model: CRO_SCORING_MODEL,
        maxTokens: 12_000,
        ledger: deps.ledger,
        system: `You write recommended next steps for deals that are not on track, on a CRO's pipeline dashboard, following these rules exactly. Today is ${deps.today}. Return one entry per deal, with its id unchanged. Write plain text with no Markdown.\n\n${CRO_RECOMMENDATION_RUBRIC}\n\n${UNTRUSTED_DATA_RULE}`,
        user: fenceUntrusted('deals and the past situations found for them', JSON.stringify(notOnTrack.map(({ deal, people }) => ({
          id: deal.id,
          opportunity: deal.name,
          type: deal.dtype,
          stage: deal.stage,
          closeDate: deal.close,
          quarterEnds: deps.quarterEndOf(deal.q),
          accountExecutive: deal.owner,
          severity: deal.severity,
          reason: deal.reason,
          secondaryReasons: deal.secondary,
          evidence: deal.evidence,
          risks: deal.backstoryRisks,
          recordedNextStep: deal.recordedNextStep,
          customerPeople: peopleForPrompt(people, 'customer'),
          ourPeople: peopleForPrompt(people, 'internal'),
          pastSituations: searchOf.get(deal.id)?.analogues ?? [],
        })))),
      })
      for (const item of parseDeals(raw, recommendationSchema)) recommendations.set(item.id, item)
    } catch (error) {
      notOnTrack.forEach(({ deal }) => fail(deal.id, error))
    }
  }

  const scored: CroDeal[] = []
  let seller = ''
  let engagedFailures = 0
  for (const item of labelled) {
    if (failed.has(item.deal.id)) continue
    seller ||= item.seller
    if (item.engagedFailed) engagedFailures += 1
    const owner = item.deal.owner ?? internalWithTitle(item.people, AE_TITLE)
    const csm = internalWithTitle(item.people, CSM_TITLE)
    const se = internalWithTitle(item.people, SE_TITLE)
    const deal: CroDeal = { ...item.deal, owner, csm, se, people: { champion: null, economicBuyer: null, execSponsor: null, se, csm, owner } }
    if (deal.status === 'not_on_track') {
      const search = searchOf.get(deal.id)
      const hasAnalogues = Boolean(search?.analogues.length)
      const recommended = recommendations.get(deal.id)
      deal.customerActions = normalizeActions(recommended?.customerActions, 'customer', item.people, item.status, hasAnalogues)
      deal.internalActions = normalizeActions(recommended?.internalActions, 'internal', item.people, item.status, hasAnalogues)
      if (!deal.customerActions.length && !deal.internalActions.length) {
        fail(deal.id, new Error('The scoring model returned no recommendation for a deal not on track.'))
        continue
      }
      deal.situationNote = search?.note || (hasAnalogues ? '' : 'No comparable past situation found.')
    }
    scored.push(deal)
  }
  return { scored, failed: [...failed], firstError, seller, engagedFailures }
}

const peopleForPrompt = (people: EngagedPerson[], side: EngagedPerson['side']) =>
  people.filter((person) => person.side === side).slice(0, MAX_PEOPLE_PER_SIDE).map(({ name, title, lastEngaged }) => ({ name, title, lastEngaged }))

/** The model's label on a deal, with the rule it cannot talk its way past: a passed close date is never on track. */
export function applyLabel(deal: CroDeal, label: Classification, today: string): CroDeal | null {
  const base: CroDeal = {
    ...deal,
    outcome: plain(label.outcome, 90),
    evidence: plain(label.evidence, 420),
    backstoryRisks: (label.backstoryRisks ?? []).map((risk) => plain(risk, 260)).filter(Boolean).slice(0, 6),
    recordedNextStep: plain(label.recordedNextStep, 300),
  }
  if (label.status === 'on_track' && deal.close >= today) {
    return { ...base, status: 'on_track', severity: null, reason: null, secondary: [], onTrackNote: plain(label.onTrackNote, 240) || base.evidence }
  }
  if (label.status === 'on_track') {
    return {
      ...base,
      status: 'not_on_track',
      severity: 'slipping',
      reason: 'Deal Execution Gap',
      secondary: [],
      outcome: 'At risk of slipping',
      evidence: plain(`The close date of ${deal.close} has passed with the deal still open. ${base.evidence}`, 420),
    }
  }
  if (!label.severity || !label.reason) return null
  const reason: CroReason = label.reason
  return { ...base, status: 'not_on_track', severity: label.severity, reason, secondary: (label.secondary ?? []).filter((item) => item !== reason).slice(0, 2) }
}
