import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { readStoredFile } from '@/lib/files/storage'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import type { CodeDataset } from '@/features/flows/code-runner'
import { looksLikeHtml } from '@/lib/html-detect'
import { runRoiPrep, type RoiFacts } from '@/lib/roi/prep'
import { summarizeFacts } from '@/lib/roi/facts'
import { renderRoiDashboard } from '@/lib/roi/dashboard'
import { applyOperations, describeView, roiOperationSchema } from '@/lib/roi/view'
import { currentRoiState, readFacts, stateJson, storeFacts } from '@/lib/roi/artifact-state'
import { listRoiSources } from '@/lib/roi/sources'
import { isRoiTimeframePreset } from '@/lib/roi/timeframe'
import { addVersion } from './service'

/**
 * The artifact plane: what the assistant can do to the artifact a
 * conversation is about. Loaded only for runs started from an artifact's
 * chat, bound to that one artifact — the model never names an artifact id,
 * so it cannot reach any other.
 *
 * Every change is a new version; nothing here overwrites or deletes. That
 * is why the plane is not a write plane for the approval gate: undo is
 * picking the previous version.
 */

export type ArtifactToolContext = { artifactId: string; executionId: string; request: string | null }

const GENERIC_TOOLS = [
  {
    name: 'get_artifact',
    description: 'The artifact this conversation is about: title, kind, versions, and the current content (or, for an ROI dashboard, its facts summary, narrative and editable view). Call it first whenever the request depends on what the artifact currently holds.',
    isWrite: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revise_artifact',
    description: 'Save a revised version of a report or document artifact. Pass the COMPLETE revised content (HTML for an HTML report, Markdown for a document) — every section, not only the changed part — and a one-line summary of what changed. The previous version is kept. Not for ROI dashboards: use update_roi_dashboard.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The whole revised document.' },
        summary: { type: 'string', description: 'What changed, in one line, for the version history.' },
      },
      required: ['content', 'summary'],
    },
  },
] as const

const ROI_TOOLS = [
  {
    name: 'update_roi_dashboard',
    description:
      'Change the ROI dashboard this conversation is about and save the result as a new version (the previous is kept). Pass `operations`, a list of edits: ' +
      'hide_tab/show_tab {tab: lead|adopt|users|deal|stage|method}; hide_section/show_section {section} (sections from get_artifact); ' +
      'hide_metric/show_metric {metric}; rename_metric {metric, label}; add_metric {metric: {key: lower_snake, label, columns: [activity-extract columns summed per rep per month], format: count|currency}} — adding recomputes the facts before this call returns, so the saved version already shows it; remove_added_metric {metric}; ' +
      'set_default_comparison {preset: last6_vs_prior6|last6_vs_year_ago|last12_vs_prior12|last3_vs_prior3}; set_headline {text}; set_lede {text}; remove_finding {index (0-based)}; upsert_finding {index?, finding: {fig, cap, h, p, tab}}; remove_watch_item {index}; upsert_watch_item {index?, item: {lead, text}}; set_note {note, paragraphs[]}; add_caveat {text}. ' +
      'Every number you write into the narrative must come from the facts summary. Returns what was applied and anything rejected, with the reason.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'The edits, applied in order. One object per edit; set `op` and only the fields that op uses.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['hide_tab', 'show_tab', 'hide_section', 'show_section', 'hide_metric', 'show_metric', 'rename_metric', 'add_metric', 'remove_added_metric', 'set_default_comparison', 'set_headline', 'set_lede', 'remove_finding', 'upsert_finding', 'remove_watch_item', 'upsert_watch_item', 'set_note', 'add_caveat'],
              },
              tab: { type: 'string', enum: ['lead', 'adopt', 'users', 'deal', 'stage', 'method'], description: 'hide_tab / show_tab' },
              section: { type: 'string', description: 'hide_section / show_section: a section id from get_artifact' },
              metric: {
                description: 'hide_metric / show_metric / rename_metric / remove_added_metric: the metric KEY (a string, e.g. "pipeline_created"). add_metric: an OBJECT {key, label, columns, format}.',
                anyOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: 'lower_snake_case, new' },
                      label: { type: 'string' },
                      columns: { type: 'array', items: { type: 'string' }, description: 'activity-extract column names from get_artifact, summed per rep per month' },
                      format: { type: 'string', enum: ['count', 'currency'] },
                    },
                    required: ['key', 'label', 'columns'],
                  },
                ],
              },
              label: { type: 'string', description: 'rename_metric: the new label' },
              preset: { type: 'string', enum: ['last6_vs_prior6', 'last6_vs_year_ago', 'last12_vs_prior12', 'last3_vs_prior3'], description: 'set_default_comparison' },
              text: { type: 'string', description: 'set_headline / set_lede / add_caveat' },
              index: { type: 'integer', description: 'remove_/upsert_finding, remove_/upsert_watch_item: 0-based; omit on upsert to append' },
              finding: {
                type: 'object',
                description: 'upsert_finding',
                properties: { fig: { type: 'string' }, cap: { type: 'string' }, h: { type: 'string' }, p: { type: 'string' }, tab: { type: 'string', enum: ['lead', 'adopt', 'users', 'deal', 'stage'] } },
                required: ['fig', 'cap', 'h', 'p', 'tab'],
              },
              item: { type: 'object', description: 'upsert_watch_item', properties: { lead: { type: 'string' }, text: { type: 'string' } }, required: ['lead', 'text'] },
              note: { type: 'string', enum: ['lead', 'adopt', 'users', 'usersTrend', 'dealWin', 'dealVel', 'stageProf', 'stageHeat', 'stageSurv', 'breadth'], description: 'set_note' },
              paragraphs: { type: 'array', items: { type: 'string' }, description: 'set_note: 1-4 paragraphs' },
            },
            required: ['op'],
          },
        },
        summary: { type: 'string', description: 'What changed, in one line, for the version history.' },
      },
      required: ['operations', 'summary'],
    },
  },
  {
    name: 'list_roi_accounts',
    description: 'Accounts whose ROI extracts are loaded in this workspace, and which extracts each has. Use before start_roi_analysis to match the account the user named.',
    isWrite: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_roi_analysis',
    description: 'Build this ROI dashboard for another account (or the same account over another time frame). Starts a new analysis in the background — five to fifteen minutes — carrying over this dashboard\'s view (hidden and added metrics, sections). Returns a link the user can open; tell them it will notify them when ready. The account must be one list_roi_accounts returns.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Exactly as list_roi_accounts names it.' },
        timeframe: { type: 'string', enum: ['last6_vs_prior6', 'last6_vs_year_ago', 'last12_vs_prior12', 'last3_vs_prior3'] },
        context: { type: 'string', description: 'Optional context for the analyst, from the user\'s request.' },
      },
      required: ['account'],
    },
  },
] as const

export type ArtifactToolDescriptor = { name: string; description: string; inputSchema: Record<string, unknown> }

/** The tools for an artifact of this kind. */
export function artifactToolsFor(kind: string): ArtifactToolDescriptor[] {
  const generic = kind === 'roi_dashboard' ? GENERIC_TOOLS.filter((tool) => tool.name === 'get_artifact') : [...GENERIC_TOOLS]
  return [...generic, ...(kind === 'roi_dashboard' ? ROI_TOOLS : [])].map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as Record<string, unknown> }))
}

const MAX_DOC_CHARS = 120_000

/**
 * The activity extract's numeric columns — what add_metric may sum. Facts
 * computed before the prep recorded them fall back to the extract's stored
 * profile, which types every column.
 */
async function activityColumnsFor(organizationId: string, facts: RoiFacts, datasetIds: string[]): Promise<string[]> {
  if (facts.U?.activityColumns?.length) return facts.U.activityColumns
  const docs = await prisma.knowledgeDocument.findMany({ where: { id: { in: datasetIds }, organizationId, assetType: 'dataset' }, select: { sourceMetadata: true } })
  for (const doc of docs) {
    const profile = (doc.sourceMetadata as { dataset?: { columns?: Array<{ name: string; type: string }> } } | null)?.dataset
    const names = profile?.columns?.map((column) => column.name) ?? []
    if (!names.includes('months') || !names.includes('email')) continue
    return (profile?.columns ?? []).filter((column) => column.type === 'number').map((column) => column.name)
  }
  return []
}

export class ArtifactToolClient {
  constructor(
    private readonly organizationId: string,
    private readonly userId: string,
    private readonly context: ArtifactToolContext,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      switch (name) {
        case 'get_artifact': return await this.getArtifact()
        case 'revise_artifact': return await this.revise(args)
        case 'update_roi_dashboard': return await this.updateRoi(args)
        case 'list_roi_accounts': return { accounts: (await listRoiSources(this.organizationId)).map((source) => ({ account: source.account, extracts: Object.keys(source.datasets) })) }
        case 'start_roi_analysis': return await this.startRoi(args)
        default: throw new Error(`Unknown artifact tool "${name}".`)
      }
    } catch (error) {
      // A tool error is the agent's to explain, not a run failure.
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async artifact() {
    const artifact = await prisma.artifact.findFirst({ where: { id: this.context.artifactId, organizationId: this.organizationId } })
    if (!artifact) throw new Error('The artifact no longer exists.')
    return artifact
  }

  private async getArtifact() {
    const artifact = await this.artifact()
    const versions = await prisma.artifactVersion.findMany({ where: { artifactId: artifact.id, organizationId: this.organizationId }, orderBy: { number: 'desc' }, take: 20, select: { number: true, request: true, createdAt: true } })
    const base = { title: artifact.title, kind: artifact.kind, versions: versions.map((v) => ({ number: v.number, change: v.request, at: v.createdAt.toISOString() })) }
    if (artifact.kind === 'roi_dashboard') {
      const current = await currentRoiState(this.organizationId, artifact.id)
      if (!current) return { ...base, error: 'The dashboard\'s underlying facts could not be found; it can be read but not edited.' }
      const facts = await readFacts(this.organizationId, current.state.factsFileId)
      if (!facts) return { ...base, error: 'The facts file behind this dashboard is missing.' }
      return {
        ...base,
        account: current.state.account,
        timeframe: current.state.timeframePreset,
        view: describeView(current.state.view, facts.U?.labels ?? {}),
        activityColumns: await activityColumnsFor(this.organizationId, facts, current.state.datasetIds),
        narrative: current.state.narrative,
        facts: summarizeFacts(facts),
      }
    }
    const version = artifact.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: this.organizationId }, select: { content: true } }) : null
    const content = version?.content ?? ''
    return { ...base, format: looksLikeHtml(content.slice(0, 4_000)) ? 'html' : 'markdown', content: content.length > MAX_DOC_CHARS ? `${content.slice(0, MAX_DOC_CHARS)}\n<!-- truncated -->` : content, truncated: content.length > MAX_DOC_CHARS }
  }

  private async revise(args: Record<string, unknown>) {
    const artifact = await this.artifact()
    if (artifact.kind === 'roi_dashboard') throw new Error('An ROI dashboard is changed with update_roi_dashboard.')
    const parsed = z.object({ content: z.string().min(20), summary: z.string().min(1).max(300) }).safeParse(args)
    if (!parsed.success) throw new Error('Pass the whole revised document in `content` and a one-line `summary`.')
    const current = artifact.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: this.organizationId }, select: { content: true } }) : null
    const wasHtml = current ? looksLikeHtml(current.content.slice(0, 4_000)) : true
    if (wasHtml !== looksLikeHtml(parsed.data.content.slice(0, 4_000))) {
      throw new Error(`The artifact is ${wasHtml ? 'an HTML report' : 'a Markdown document'}; keep the revision in the same format.`)
    }
    // A truncated read must not become a truncated version.
    if (current && current.content.length > MAX_DOC_CHARS && parsed.data.content.length < current.content.length * 0.6) {
      throw new Error('That revision is much shorter than the document, which was too long to read whole. Make a targeted change instead, or say which part to rewrite.')
    }
    const version = await addVersion({ artifactId: artifact.id, organizationId: this.organizationId, content: parsed.data.content, executionId: this.context.executionId, request: this.context.request ?? parsed.data.summary, createdByUserId: this.userId })
    return { saved: true, version: version.number, link: `/artifacts/${artifact.id}` }
  }

  private async updateRoi(args: Record<string, unknown>) {
    const artifact = await this.artifact()
    if (artifact.kind !== 'roi_dashboard') throw new Error('This artifact is not an ROI dashboard; use revise_artifact.')
    const operations = Array.isArray(args.operations) ? args.operations : []
    if (!operations.length) throw new Error('Pass at least one operation.')
    const parsedOps = operations.map((operation) => roiOperationSchema.safeParse(operation))
    const malformed = parsedOps
      .map((result, index) => {
        if (result.success) return null
        const issue = result.error.issues[0]
        const op = (operations[index] as { op?: unknown } | null)?.op
        return `operation ${index + 1} (${typeof op === 'string' ? op : 'no op'}): ${issue?.path.length ? `${issue.path.join('.')} — ` : ''}${issue?.message ?? 'malformed'}`
      })
      .filter(Boolean) as string[]
    const valid = parsedOps.flatMap((result) => (result.success ? [result.data] : []))
    const current = await currentRoiState(this.organizationId, artifact.id)
    if (!current) throw new Error('The dashboard\'s underlying facts could not be found, so it cannot be edited.')
    let facts = await readFacts(this.organizationId, current.state.factsFileId)
    if (!facts) throw new Error('The facts file behind this dashboard is missing.')
    const result = applyOperations(
      { view: current.state.view, narrative: current.state.narrative },
      valid,
      { metricKeys: Object.keys(facts.U?.labels ?? {}), activityColumns: await activityColumnsFor(this.organizationId, facts, current.state.datasetIds) },
    )
    const rejected = [...malformed, ...result.rejected]
    if (!result.applied.length) return { saved: false, rejected }
    let factsFileId = current.state.factsFileId
    if (result.recompute) {
      // Only the activity section depends on metrics: recompute it (from the
      // activity and usage extracts) and keep the deal and stage sections.
      const fresh = await this.recompute(current.state.datasetIds, result.view.extraMetrics)
      if (!fresh.U) throw new Error('The activity extract could not be recomputed.')
      facts = { ...facts, U: fresh.U, META: { ...facts.META, capP: fresh.META.capP, capPO: fresh.META.capPO } }
      factsFileId = await storeFacts(this.organizationId, this.userId, facts)
    }
    const state = { ...current.state, factsFileId, narrative: result.narrative, view: result.view }
    const html = renderRoiDashboard(facts, result.narrative, { account: state.account, timeframePreset: state.timeframePreset, view: result.view })
    const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim().slice(0, 300) : result.applied.join('; ')
    const version = await addVersion({ artifactId: artifact.id, organizationId: this.organizationId, content: html, executionId: this.context.executionId, request: this.context.request ?? summary, createdByUserId: this.userId, state: stateJson(state) })
    return { saved: true, version: version.number, applied: result.applied, ...(rejected.length ? { rejected } : {}), link: `/artifacts/${artifact.id}`, note: 'Saved: the new version already shows every applied change — nothing is still processing.' }
  }

  private async recompute(datasetIds: string[], extraMetrics: Array<{ key: string; label: string; columns: string[]; format?: string }>): Promise<RoiFacts> {
    const all = await prisma.knowledgeDocument.findMany({ where: { id: { in: datasetIds }, organizationId: this.organizationId, assetType: 'dataset' }, select: { filename: true, storedFileId: true, sourceMetadata: true } })
    // The activity and usage extracts only — the two the activity section is
    // built from. Tagged extracts say which they are; untagged ones are read
    // by their columns (activity has months + email; usage has an email and no
    // months or opportunity columns).
    const kindOf = (doc: (typeof all)[number]) => {
      const meta = doc.sourceMetadata as { roi?: { kind?: string }; dataset?: { columns?: Array<{ name: string }> } } | null
      if (meta?.roi?.kind) return meta.roi.kind
      const names = (meta?.dataset?.columns ?? []).map((column) => column.name.toLowerCase())
      if (names.includes('months') && names.includes('email')) return 'activity'
      if (names.some((name) => name.includes('email')) && !names.some((name) => name.includes('opportunit') || name === 'months')) return 'usage'
      return 'other'
    }
    const docs = all.filter((doc) => kindOf(doc) === 'activity' || kindOf(doc) === 'usage')
    const datasets: CodeDataset[] = []
    for (const doc of docs) {
      if (!doc.storedFileId) continue
      const stored = await readStoredFile(doc.storedFileId, this.organizationId)
      if (!stored) throw new Error(`The extract "${doc.filename}" could not be read.`)
      datasets.push({ name: datasetFrameName(doc.filename), filename: doc.filename, bytes: stored.buffer })
    }
    if (!datasets.length) throw new Error('The extracts behind this dashboard are no longer in the repository.')
    return runRoiPrep(datasets, { extraMetrics, onlyActivity: true })
  }

  private async startRoi(args: Record<string, unknown>) {
    const artifact = await this.artifact()
    const account = typeof args.account === 'string' ? args.account.trim() : ''
    if (!account) throw new Error('Name the account.')
    const sources = await listRoiSources(this.organizationId)
    const match = sources.find((source) => source.account.toLowerCase() === account.toLowerCase())
    if (!match) {
      return { started: false, reason: `No extracts are loaded for "${account}".`, accountsWithExtracts: sources.map((source) => source.account), hint: 'An operator loads an account\'s extracts into the Repository; until then it cannot be analysed.' }
    }
    const current = artifact.kind === 'roi_dashboard' ? await currentRoiState(this.organizationId, artifact.id) : null
    const timeframe = isRoiTimeframePreset(args.timeframe) ? args.timeframe : (current?.state.timeframePreset && isRoiTimeframePreset(current.state.timeframePreset) ? current.state.timeframePreset : 'last6_vs_prior6')
    const { createRoiAnalysis } = await import('@/lib/roi/service')
    const row = await createRoiAnalysis({
      organizationId: this.organizationId,
      userId: this.userId,
      account: match.account,
      timeframe: { preset: timeframe },
      context: typeof args.context === 'string' ? args.context.slice(0, 4_000) : '',
      view: current?.state.view,
    })
    if (row.status === 'failed') return { started: false, reason: row.error ?? 'The analysis could not be started.' }
    return { started: true, account: match.account, timeframe, link: row.artifactId ? `/artifacts/${row.artifactId}` : '/artifacts', note: 'Runs in the background, five to fifteen minutes; the user is notified when the dashboard is ready.' }
  }
}
