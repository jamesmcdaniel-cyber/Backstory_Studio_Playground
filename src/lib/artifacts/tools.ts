import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { readStoredFile } from '@/lib/files/storage'
import { datasetFrameName } from '@/lib/code-analysis/frame-name'
import type { CodeDataset } from '@/features/flows/code-runner'
import { looksLikeHtml } from '@/lib/html-detect'
import { runRoiPrep, type RoiFacts } from '@/lib/roi/prep'
import { summarizeFacts } from '@/lib/roi/facts'
import { renderRoiDashboard, ROI_RENDER_VERSION } from '@/lib/roi/dashboard'
import { applyOperations, describeView, roiOperationSchema } from '@/lib/roi/view'
import { currentRoiState, readAccount360Facts, readFacts, stateJson, storeFacts } from '@/lib/roi/artifact-state'
import { isRoiTemplate, listRoiSources, ROI_TEMPLATES, type RoiTemplate } from '@/lib/roi/sources'
import { summarizeAccount360 } from '@/lib/roi/account360/facts'
import type { Account360Facts } from '@/lib/roi/account360/prep'
import { isRoiTimeframePreset } from '@/lib/roi/timeframe'
import { configFromPreset, describeRunConfig } from '@/lib/roi/config'
import { addVersion, createArtifact } from './service'

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

import { guestChangesToday } from './guest-limits'
import { GUEST_COPILOT_LIMITS } from './template-policy'

export type ArtifactToolContext = { artifactId: string; executionId: string; request: string | null; expectedVersionId?: string; templateCopy?: boolean; guestCopy?: boolean }

const GENERIC_TOOLS = [
  {
    name: 'get_artifact',
    description: 'The artifact this conversation is about: title, kind, versions, and the current content (the whole of it when it is small; the start plus its size when large — use find_in_artifact / read_artifact to navigate a large one), or, for an ROI dashboard, its facts summary, narrative and editable view. Call it first whenever the request depends on what the artifact currently holds.',
    isWrite: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_in_artifact',
    description: 'Find text in the current version (case-insensitive). Returns each match with its character offset and the surrounding lines — use it to locate what a change touches in a large page before editing. Pass EVERY term you need in `texts` in one call rather than calling once per term.',
    isWrite: false,
    inputSchema: { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' }, description: 'Up to 12 terms to look for, all answered in this one call.' }, text: { type: 'string', description: 'A single term (use `texts` for several).' } } },
  },
  {
    name: 'read_artifact',
    description: 'Read part of the current version by character offset (up to 40,000 characters at a time).',
    isWrite: false,
    inputSchema: { type: 'object', properties: { offset: { type: 'integer' }, length: { type: 'integer', description: 'At most 40000.' } }, required: ['offset'] },
  },
  {
    name: 'edit_artifact',
    description: 'Make targeted changes to a report, document or interactive page and save them as a new version — the right tool for most changes, and the only practical one for a large page. Each edit replaces `find` (an exact snippet copied from the current content, long enough to be unique) with `replace`; set `all: true` to replace every occurrence. Edits apply in order; if any `find` is missing or ambiguous nothing is saved and the reason is returned. Set `saveAsNew: true` (with an optional `title`) to save the result as a NEW artifact instead — when the user asks for a copy, a variant or "a new one" — leaving this artifact unchanged.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact text from the current content.' },
              replace: { type: 'string', description: 'What it becomes (empty string to delete).' },
              all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
            },
            required: ['find', 'replace'],
          },
        },
        summary: { type: 'string', description: 'What changed, in one line, for the version history.' },
        saveAsNew: { type: 'boolean', description: 'Save as a new artifact instead of a new version.' },
        title: { type: 'string', description: 'Title for the new artifact when saveAsNew is set.' },
      },
      required: ['edits', 'summary'],
    },
  },
  {
    name: 'revise_artifact',
    description: 'Replace the whole content with a rewritten version — only for a full rewrite of a small report or document (prefer edit_artifact for changes). Pass the COMPLETE content in the same format and a one-line summary. Set `saveAsNew: true` (optional `title`) to save it as a new artifact instead. Not for ROI dashboards.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The whole revised document.' },
        summary: { type: 'string', description: 'What changed, in one line, for the version history.' },
        saveAsNew: { type: 'boolean' },
        title: { type: 'string' },
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
      'hide_tab/show_tab {tab: activity|adoption|deals|stage|accounts|method} (the Executive summary always shows); hide_section/show_section {section} (sections from get_artifact); ' +
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
              tab: { type: 'string', enum: ['activity', 'adoption', 'deals', 'stage', 'accounts', 'method'], description: 'hide_tab / show_tab' },
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
                properties: { fig: { type: 'string' }, cap: { type: 'string' }, h: { type: 'string' }, p: { type: 'string' }, tab: { type: 'string', enum: ['activity', 'adoption', 'deals', 'stage', 'accounts'] } },
                required: ['fig', 'cap', 'h', 'p', 'tab'],
              },
              item: { type: 'object', description: 'upsert_watch_item', properties: { lead: { type: 'string' }, text: { type: 'string' } }, required: ['lead', 'text'] },
              note: { type: 'string', enum: ['lead', 'mix', 'adopt', 'users', 'usersTrend', 'dealWin', 'dealVel', 'dealTrend', 'stageProf', 'stageHeat', 'stageSurv', 'breadth', 'accounts', 'accountDeals'], description: 'set_note' },
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
    description: 'Accounts the ROI report can show: those with extracts loaded in this workspace (which extracts, which analyses they can run) and those with a report already built. Use before start_roi_analysis to match the account the user named.',
    isWrite: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_roi_analysis',
    description: 'Show this ROI report for another account (or the same account with other settings). The ROI report shows one account at a time on the person\'s own ROI page: another account opens THERE, in the same layout, as the page\'s next version — at once when the account already has a report (`opened: true`), or after a background build of a few minutes when it does not (`started: true`; the person is notified). New settings (a time frame) rewrite the findings in about a minute. Only when the user explicitly asks for a separate copy or a new artifact, pass `asNewArtifact: true`. The account must be one list_roi_accounts returns.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Exactly as list_roi_accounts names it. For an opportunity, its account.' },
        asNewArtifact: { type: 'boolean', description: 'Only when the user explicitly asked for a separate copy or a new artifact. Otherwise omit: the account opens on their ROI page.' },
        template: { type: 'string', enum: ['standard', 'engagement', 'account360'], description: 'standard = the consolidated ROI report (every section the account\'s extracts feed); engagement = rep engagement only; account360 = Account 360 click-stream → pipeline only. Defaults to this dashboard\'s own.' },
        timeframe: { type: 'string', enum: ['last6_vs_prior6', 'last6_vs_year_ago', 'last12_vs_prior12', 'last3_vs_prior3'], description: 'Only when the user asked for a different time frame; otherwise this dashboard\'s configuration carries over.' },
        reason: { type: 'string', description: 'Why the user wants it (QBR, renewal, churn risk…), from their request. Defaults to this dashboard\'s reason.' },
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
  // An ROI dashboard is edited through its view; a page (an Account 360
  // dashboard among them) is edited as HTML, and can still be rebuilt for
  // another account from its extracts.
  const roi = kind === 'roi_dashboard' ? ROI_TOOLS : kind === 'page' ? ROI_TOOLS.filter((tool) => tool.name !== 'update_roi_dashboard') : []
  return [...generic, ...roi].map(({ name, description, inputSchema }) => ({ name, description, inputSchema: inputSchema as Record<string, unknown> }))
}

type PageRoiState = { template: RoiTemplate; account: string; factsFileId: string; datasetIds: string[]; headline?: string }

/** The analysis a page was built from, when it was built by one (an Account 360 dashboard). */
function pageRoiState(state: unknown): PageRoiState | null {
  const roi = (state as { roi?: Partial<PageRoiState> } | null)?.roi
  return roi && isRoiTemplate(roi.template) && typeof roi.account === 'string' && typeof roi.factsFileId === 'string'
    ? { template: roi.template, account: roi.account, factsFileId: roi.factsFileId, datasetIds: Array.isArray(roi.datasetIds) ? roi.datasetIds : [], headline: roi.headline }
    : null
}

const MAX_DOC_CHARS = 120_000
const LARGE_DOC_PREVIEW_CHARS = 20_000
const READ_WINDOW_MAX = 40_000

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
      if (this.context.templateCopy && (!GENERIC_TOOLS.some(tool => tool.name === name) || args.saveAsNew)) {
        throw new Error('This copilot can only read and revise your template copy.')
      }
      switch (name) {
        case 'get_artifact': return await this.getArtifact()
        case 'revise_artifact': return await this.revise(args)
        case 'edit_artifact': return await this.edit(args)
        case 'find_in_artifact': return await this.find(args)
        case 'read_artifact': return await this.read(args)
        case 'update_roi_dashboard': return await this.updateRoi(args)
        case 'list_roi_accounts': return await this.listRoiAccounts()
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
    // A guest copy (no owner) is reachable only from its own copilot's run.
    if (artifact.templateSourceId && !(artifact.userId ? artifact.userId === this.userId : this.context.templateCopy && artifact.guestDigest)) throw new Error('Artifact not found.')
    if (this.context.expectedVersionId && artifact.currentVersionId !== this.context.expectedVersionId) throw new Error('Artifact changed since this request started. Reload and retry the change; nothing was saved.')
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
      const config = current.state.config ?? configFromPreset(current.state.timeframePreset)
      const a360 = await readAccount360Facts(this.organizationId, current.state.a360FactsFileId)
      return {
        ...base,
        account: current.state.account,
        configuration: describeRunConfig(config),
        ...(current.state.reason ? { reason: current.state.reason } : {}),
        view: describeView(current.state.view, facts.U?.labels ?? {}),
        activityColumns: await activityColumnsFor(this.organizationId, facts, current.state.datasetIds),
        narrative: current.state.narrative,
        facts: summarizeFacts(facts, config),
        ...(a360 ? { accountEngagement: summarizeAccount360(a360) } : {}),
      }
    }
    const version = artifact.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: this.organizationId }, select: { content: true, state: true } }) : null
    const content = version?.content ?? ''
    const large = content.length > MAX_DOC_CHARS
    const analysis = await this.pageAnalysis(version?.state)
    return {
      ...base,
      ...(analysis ? { analysis } : {}),
      format: looksLikeHtml(content.slice(0, 4_000)) ? 'html' : 'markdown',
      size: content.length,
      content: large ? content.slice(0, LARGE_DOC_PREVIEW_CHARS) : content,
      ...(large ? { note: `This is the first ${LARGE_DOC_PREVIEW_CHARS.toLocaleString()} of ${content.length.toLocaleString()} characters. Use find_in_artifact to locate what a change touches, read_artifact for a window around it, and edit_artifact to change it.` } : {}),
    }
  }

  /** An Account 360 page's computed facts, so questions are answered from them rather than from the page's text. */
  private async pageAnalysis(state: unknown) {
    const roi = pageRoiState(state)
    if (!roi) return null
    const stored = await readStoredFile(roi.factsFileId, this.organizationId).catch(() => null)
    let summary: ReturnType<typeof summarizeAccount360> | null = null
    try {
      summary = stored ? summarizeAccount360(JSON.parse(stored.buffer.toString('utf8')) as Account360Facts) : null
    } catch {
      summary = null
    }
    return {
      template: roi.template,
      templateLabel: ROI_TEMPLATES[roi.template].label,
      account: roi.account,
      headline: roi.headline ?? null,
      summary,
      datasetIds: roi.datasetIds,
      note: 'Built from repository extracts. Answer questions from `summary` (and run_code over datasetIds for anything it lacks); rebuild for another account with start_roi_analysis.',
    }
  }

  private async revise(args: Record<string, unknown>) {
    const parsed = z.object({ content: z.string().min(20), summary: z.string().min(1).max(300), saveAsNew: z.boolean().optional(), title: z.string().max(200).optional() }).safeParse(args)
    if (!parsed.success) throw new Error('Pass the whole revised document in `content` and a one-line `summary`.')
    const { artifact, content: current } = await this.currentContent()
    const wasHtml = current ? looksLikeHtml(current.slice(0, 4_000)) : true
    if (wasHtml !== looksLikeHtml(parsed.data.content.slice(0, 4_000))) {
      throw new Error(`The artifact is ${wasHtml ? 'an HTML page' : 'a Markdown document'}; keep the revision in the same format.`)
    }
    // A page too large to read whole is changed with edit_artifact, never retyped.
    if (current.length > MAX_DOC_CHARS && parsed.data.content.length < current.length * 0.6) {
      throw new Error('That revision is much shorter than the page, which is too large to rewrite whole. Use edit_artifact for targeted changes.')
    }
    return this.save(artifact, parsed.data.content, parsed.data.summary, parsed.data.saveAsNew, parsed.data.title)
  }

  private async currentContent(): Promise<{ artifact: Awaited<ReturnType<ArtifactToolClient['artifact']>>; content: string }> {
    const artifact = await this.artifact()
    if (artifact.kind === 'roi_dashboard') throw new Error('An ROI dashboard is changed with update_roi_dashboard.')
    const version = artifact.currentVersionId ? await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: this.organizationId }, select: { content: true } }) : null
    return { artifact, content: version?.content ?? '' }
  }

  private async find(args: Record<string, unknown>) {
    // Several terms in one call: each lookup used to cost a model round trip.
    const terms = [...new Set([...(Array.isArray(args.texts) ? args.texts : []), args.text].filter((term): term is string => typeof term === 'string' && Boolean(term.trim())))].slice(0, 12)
    if (!terms.length) throw new Error('Pass the text to find.')
    const { content } = await this.currentContent()
    const haystack = content.toLowerCase()
    // One term keeps its 20 matches; several share the budget so the answer stays readable.
    const limit = terms.length === 1 ? 20 : 6
    const search = (text: string) => {
      const needle = text.toLowerCase()
      const matches: Array<{ offset: number; context: string }> = []
      for (let at = haystack.indexOf(needle); at >= 0 && matches.length < limit; at = haystack.indexOf(needle, at + needle.length)) {
        const start = Math.max(0, content.lastIndexOf('\n', Math.max(0, at - 200)))
        const endBreak = content.indexOf('\n', at + needle.length + 200)
        matches.push({ offset: at, context: content.slice(start, endBreak < 0 ? Math.min(content.length, at + 600) : endBreak).slice(0, terms.length === 1 ? 1_200 : 700) })
      }
      return { matches, ...(matches.length === limit ? { note: `Showing the first ${limit} matches; search for something more specific.` } : {}) }
    }
    if (terms.length === 1) return { size: content.length, ...search(terms[0]) }
    return { size: content.length, results: terms.map((text) => ({ text, ...search(text) })) }
  }

  private async read(args: Record<string, unknown>) {
    const { content } = await this.currentContent()
    const offset = Math.max(0, Math.min(Number(args.offset) || 0, content.length))
    const length = Math.max(1, Math.min(Number(args.length) || READ_WINDOW_MAX, READ_WINDOW_MAX))
    return { size: content.length, offset, text: content.slice(offset, offset + length), nextOffset: offset + length < content.length ? offset + length : null }
  }

  private async edit(args: Record<string, unknown>) {
    const parsed = z.object({
      edits: z.array(z.object({ find: z.string().min(1), replace: z.string(), all: z.boolean().optional() })).min(1).max(100),
      summary: z.string().min(1).max(300),
      saveAsNew: z.boolean().optional(),
      title: z.string().max(200).optional(),
    }).safeParse(args)
    if (!parsed.success) throw new Error('Pass `edits` as [{find, replace}] and a one-line `summary`.')
    const { artifact, content } = await this.currentContent()
    const applied = applyTextEdits(content, parsed.data.edits)
    if ('error' in applied) return { saved: false, error: applied.error }
    return this.save(artifact, applied.content, parsed.data.summary, parsed.data.saveAsNew, parsed.data.title)
  }

  /** Save content as the artifact's next version, or as a new artifact. */
  private async save(artifact: Awaited<ReturnType<ArtifactToolClient['artifact']>>, content: string, summary: string, saveAsNew?: boolean, title?: string) {
    if (artifact.templateSourceId && saveAsNew) throw new Error('This copilot can only save versions of your template copy.')
    if (saveAsNew) {
      const { artifact: created } = await createArtifact({
        organizationId: this.organizationId,
        userId: this.userId,
        kind: artifact.kind === 'page' || artifact.kind === 'document' ? artifact.kind : 'report',
        title: title?.trim() || `${artifact.title} (copy)`,
        content,
        agentTaskId: artifact.agentTaskId,
        flowId: artifact.flowId,
      })
      return { saved: true, newArtifact: true, title: created.title, link: `/artifacts/${created.id}`, note: `Saved as a new artifact; "${artifact.title}" is unchanged. Share the link.` }
    }
    // An anonymous visitor's copy takes a fixed number of changes a day. A run
    // that already saved may keep saving: the cap counts runs, not saves.
    if (this.context.guestCopy && await guestChangesToday(this.organizationId, artifact.id, this.context.executionId) >= GUEST_COPILOT_LIMITS.changesPerVisitor) {
      throw new Error(`This copy has had its ${GUEST_COPILOT_LIMITS.changesPerVisitor} changes for today, so nothing was saved. Tell the user changes are available again tomorrow (or straight away in their own workspace if they sign in); questions can still be answered.`)
    }
    const version = await addVersion({ artifactId: artifact.id, organizationId: this.organizationId, expectedVersionId: artifact.currentVersionId, content, executionId: this.context.executionId, request: this.context.request ?? summary, createdByUserId: this.userId })
    this.context.expectedVersionId = version.id
    return { saved: true, version: version.number, link: `/artifacts/${artifact.id}`, note: 'Saved: the new version is live now.' }
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
    const state = { ...current.state, factsFileId, narrative: result.narrative, view: result.view, render: ROI_RENDER_VERSION }
    const a360 = await readAccount360Facts(this.organizationId, state.a360FactsFileId)
    const html = renderRoiDashboard(facts, result.narrative, { account: state.account, timeframePreset: state.timeframePreset, view: result.view, config: state.config, reason: state.reason, a360 })
    const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim().slice(0, 300) : result.applied.join('; ')
    const version = await addVersion({ artifactId: artifact.id, organizationId: this.organizationId, expectedVersionId: artifact.currentVersionId, content: html, executionId: this.context.executionId, request: this.context.request ?? summary, createdByUserId: this.userId, state: stateJson(state) })
    this.context.expectedVersionId = version.id
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

  private async listRoiAccounts() {
    const { listAccountReports } = await import('@/lib/roi/service')
    const [sources, reports] = await Promise.all([listRoiSources(this.organizationId), listAccountReports(this.organizationId)])
    const shows = (report: (typeof reports)[number]) => Boolean(report.state || report.a360)
    const accounts = sources.map((source) => ({ account: source.account, extracts: Object.keys(source.datasets), templates: source.templates, hasReport: reports.some((report) => report.account.toLowerCase() === source.account.toLowerCase() && shows(report)) }))
    for (const report of reports) {
      if (shows(report) && !accounts.some((entry) => entry.account.toLowerCase() === report.account.toLowerCase())) accounts.push({ account: report.account, extracts: [], templates: ['standard'], hasReport: true })
    }
    return { accounts }
  }

  private async startRoi(args: Record<string, unknown>) {
    const artifact = await this.artifact()
    const account = typeof args.account === 'string' ? args.account.trim() : ''
    if (!account) throw new Error('Name the account.')
    const pageState = artifact.kind === 'page' && artifact.currentVersionId
      ? pageRoiState((await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: this.organizationId }, select: { state: true } }))?.state)
      : null
    const template: RoiTemplate | null = isRoiTemplate(args.template) ? args.template : artifact.kind === 'roi_dashboard' ? 'standard' : pageState?.template ?? null
    if (!template) throw new Error('This page was not built by an ROI analysis; pass template (standard, engagement or account360).')
    const service = await import('@/lib/roi/service')
    const { RoiDataUnavailableError } = await import('@/lib/roi/data-source')
    const sources = await listRoiSources(this.organizationId)
    const match = sources.find((source) => source.account.toLowerCase() === account.toLowerCase())
    const report = template === 'standard' ? await service.findAccountReport(this.organizationId, account) : null
    const name = report?.account ?? match?.account ?? null
    const asNew = args.asNewArtifact === true || template !== 'standard'
    if (!name || (asNew && (!match || !match.templates.includes(template)))) {
      return {
        started: false,
        reason: match ? `"${match.account}" has extracts loaded, but not the ones the ${ROI_TEMPLATES[template].label} needs.` : `"${account}" has no ROI report and no extracts loaded.`,
        accountsWithExtracts: sources.filter((source) => source.templates.includes(template)).map((source) => source.account),
        hint: 'An operator loads an account\'s extracts into the Repository (or connects the data flow); until then it cannot be analysed.',
      }
    }
    const current = artifact.kind === 'roi_dashboard' && template !== 'account360' ? await currentRoiState(this.organizationId, artifact.id) : null
    // The same configuration as this dashboard unless a time frame was asked for.
    const newSettings = isRoiTimeframePreset(args.timeframe)
    const config = newSettings
      ? { ...configFromPreset(args.timeframe as string), cohort: current?.state.config?.cohort ?? 'tiers', fiscalYearStartMonth: current?.state.config?.fiscalYearStartMonth ?? null }
      : current?.state.config ?? configFromPreset(current?.state.timeframePreset)
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 1_000) : current?.state.reason ?? 'Requested from the ROI dashboard assistant'
    const context = typeof args.context === 'string' ? args.context.slice(0, 4_000) : ''
    try {
      if (!asNew) {
        // The person's own ROI page shows the account, in its layout: the
        // page's next version, never another artifact.
        const opened = await service.openRoiAccount({ organizationId: this.organizationId, userId: this.userId, account: name })
        if (opened.status === 'ready' && !newSettings) {
          return { opened: true, account: name, link: service.roiPageLink(name), note: `The ROI page shows ${name} now, in the same layout — its next version, nothing new to open. Say so in one sentence; offer to change anything.` }
        }
        const row = await service.requestRoiReport({ organizationId: this.organizationId, userId: this.userId, account: name, config, reason, context })
        if (row.status === 'failed') return { started: false, reason: row.error ?? 'The analysis could not be started.' }
        return {
          started: true,
          account: name,
          configuration: describeRunConfig(config),
          link: service.roiPageLink(name),
          note: opened.status === 'ready'
            ? 'The findings are being rewritten for the new settings — about a minute. The ROI page updates in place; the person is notified.'
            : `${name} has no report yet, so it is being built from its data — a few minutes. It lands on the ROI page, in this layout; the person is notified.`,
        }
      }
      // A separate artifact, because the user asked for one (or another analysis).
      const row = await service.createRoiAnalysis({ organizationId: this.organizationId, userId: this.userId, account: match!.account, config, reason, context, view: current?.state.view, template, markers: { separate: true } })
      if (row.status === 'failed') return { started: false, reason: row.error ?? 'The analysis could not be started.' }
      return { started: true, account: match!.account, template, configuration: describeRunConfig(config), link: row.artifactId ? `/artifacts/${row.artifactId}` : '/artifacts', note: 'A separate artifact, built in the background — a few minutes; the person is notified when it is ready.' }
    } catch (error) {
      if (error instanceof service.RoiBusyError || error instanceof RoiDataUnavailableError) return { started: false, reason: error.message }
      throw error
    }
  }
}

/**
 * Exact find-and-replace edits, applied in order, all or nothing. A `find`
 * that is missing, or ambiguous without `all`, rejects the whole set with a
 * reason the agent can act on — a partial edit of a page is worse than none.
 */
export function applyTextEdits(content: string, edits: Array<{ find: string; replace: string; all?: boolean }>): { content: string } | { error: string } {
  let next = content
  for (const [index, edit] of edits.entries()) {
    const first = next.indexOf(edit.find)
    if (first < 0) return { error: `Edit ${index + 1}: that text was not found in the current content (it must match exactly, including spacing). Use find_in_artifact to copy it.` }
    if (!edit.all && next.indexOf(edit.find, first + edit.find.length) >= 0) {
      return { error: `Edit ${index + 1}: that text appears more than once. Include more surrounding text to make it unique, or set all: true.` }
    }
    next = edit.all ? next.split(edit.find).join(edit.replace) : next.slice(0, first) + edit.replace + next.slice(first + edit.find.length)
  }
  if (next === content) return { error: 'The edits made no change.' }
  return { content: next }
}
