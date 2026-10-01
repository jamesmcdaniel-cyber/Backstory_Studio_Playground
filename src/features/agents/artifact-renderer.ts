import { generateLongText } from '@/lib/llm/model-runner'
import type { LedgerContext } from '@/lib/llm/model-runner'
import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE, fenceUntrusted } from '@/lib/security/prompt'
import { htmlDocumentOf } from '@/lib/html-detect'
import { compileArtifactPage, reactArtifactDocument, reactComponentOf } from '@/lib/artifacts/runtime'
import { validateArtifactContent } from '@/lib/artifacts/validate-content'
import { ARTIFACT_CAPABILITIES } from '@/lib/artifacts/capabilities'

/**
 * The artifact renderer: the pass that turns a run's deliverable into a
 * complete interactive artifact — as full as the ROI analysis page the team
 * holds up as the bar — on the strongest model.
 *
 * The agent's own turns gather the facts and draft the deliverable while
 * juggling tools; a thin page is the natural result. This pass has one job:
 * given the draft and the evidence the run collected, build the finished app.
 * Everything the agent read is untrusted data (fenced); the output runs in the
 * artifact sandbox, and the executor falls back to the draft on any failure.
 */

export const ARTIFACT_RENDER_MODEL = process.env.ARTIFACT_RENDER_MODEL?.trim() || 'claude-opus-5-5'
const RENDER_MAX_TOKENS = 64_000
const DRAFT_MAX_CHARS = 160_000
const EVIDENCE_MAX_CHARS = 120_000
const EVIDENCE_PER_RESULT = 12_000

export const ARTIFACT_RENDER_SPEC = `You are the artifact renderer. You turn an AI agent's draft deliverable, and the evidence its run collected, into a finished interactive artifact — a single-file React app that a revenue leader opens, reads in five minutes, and clicks through for the detail. The bar is a complete analytical product, not a report page.

WHAT "COMPLETE" MEANS: choose the right product shape for the actual task using the product-design contract below. Do not force every artifact into a dark masthead, KPI row and 3–6 tabs. Give the primary working surface most of the space, make the important actions immediately usable, and reveal secondary detail progressively. An analytical product needs a compelling visual built from real data, useful filters and an entity inspector; an operational tracker needs editing, search, validation and durable records; a brief needs excellent editorial hierarchy and source-linked evidence. Include only what serves the user's task. Show definitions, sources, as-of dates and data gaps in an accessible method section. Never manufacture metrics to fill a layout.

DATA DISCIPLINE: use ALL of the data in the draft and the evidence — every entity, every metric; never drop rows to save space. Embed it COMPACTLY: one line per record, short keys, arrays for series (e.g. \`["Acme","Power Users",17,0.18,[14517,19121700,0]]\` with a column list), no pretty-printing — the whole module must fit well inside your output budget, so spend tokens on views and interpretation, not on whitespace. Never invent a number, name, date or finding: if something is not in the draft or evidence, it does not appear (say so in Method where it matters). Embed the data as constants at the top of the module and compute totals, averages, shares, ranks and deltas in code from those constants — never hand-type a derived number. Counts precise, units explicit.

DESIGN: use the opt-in offline UI kit from the product-design contract, supplemented with custom CSS or Tailwind where needed. Select an intentional task-specific composition, typography scale and palette. Prefer lucide-react icons to emoji. Charts with recharts: labelled axes, formatted ticks ($1.2M, 45%), tooltips, legends when more than one series, consistent colors per entity. A polished UI is not evidence that its data or calculations are correct.

TECHNICAL: ONE module, \`export default function App()\`, React hooks for navigation (no URL changes, no router). Reuse small components. Implement the requested features without a line-count target. Supported imports: react, recharts, lucide-react, @backstory/artifact, @/components/ui/card | button | badge | tabs | alert | input | label | textarea | progress | separator | table | select | switch | skeleton, d3, lodash, papaparse, mathjs, xlsx, chart.js, mermaid, marked. Use the artifact SDK below for durable application state and worker Python. No arbitrary network, fetch/XHR/WebSocket, localStorage/sessionStorage, or external images/fonts.

OUTPUT: the component source only, raw — no prose before or after, no explanation. If the draft is a static HTML report, its content is your material; the output is still the React app.`

type TranscriptBlock = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; text?: string }
type TranscriptMessage = { role?: string; content?: unknown }

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part as TranscriptBlock)?.text ?? '')).join('\n')
  return ''
}

/** The tool results a run collected, labelled by tool, capped — the renderer's evidence. */
export function evidenceFromTranscript(transcript: unknown[]): string {
  const names = new Map<string, string>()
  const parts: string[] = []
  let total = 0
  for (const message of transcript as TranscriptMessage[]) {
    if (!Array.isArray(message?.content)) continue
    for (const block of message.content as TranscriptBlock[]) {
      if (block?.type === 'tool_use' && block.id) names.set(block.id, block.name ?? 'tool')
      if (block?.type !== 'tool_result') continue
      const text = blockText(block.content).trim()
      if (!text) continue
      const entry = `### ${names.get(block.tool_use_id ?? '') ?? 'tool'}\n${text.slice(0, EVIDENCE_PER_RESULT)}`
      if (total + entry.length > EVIDENCE_MAX_CHARS) return parts.join('\n\n')
      parts.push(entry)
      total += entry.length
    }
  }
  return parts.join('\n\n')
}

/** Whether a run's final answer is a deliverable the renderer should finish (an HTML document or a React component). */
export function isDeliverable(summary: string): boolean {
  return Boolean(htmlDocumentOf(summary) || reactComponentOf(summary))
}

/** Avoid a second multi-minute model rewrite of an already substantial app.
 * Validation is still mandatory. HTML/Python must not be converted to React. */
export function needsArtifactRender(draft: string): boolean {
  if (!isDeliverable(draft)) return false
  try {
    validateArtifactContent(draft)
    if (/<script\b[^>]*type=["'](?:text\/python|py)/i.test(draft)) return false
    if (draft.length >= 4_000 && /\b(?:onClick|addEventListener|onclick|onChange)\b/.test(draft)) return false
  } catch { return true }
  return true
}

export function buildArtifactRenderPrompt(params: { objective: string; request: string; draft: string; evidence: string }): { system: string; user: string } {
  return {
    system: [ARTIFACT_RENDER_SPEC, ARTIFACT_CAPABILITIES, 'Preserve every requested capability. No arbitrary length target; implement the required features concisely.', UNTRUSTED_DATA_RULE, GUARDRAIL_RULE].join('\n\n'),
    user: [
      fenceUntrusted('what the agent was asked to do', `${params.objective}\n\n${params.request}`.slice(0, 8_000)),
      fenceUntrusted('the agent\'s draft deliverable', params.draft.slice(0, DRAFT_MAX_CHARS)),
      params.evidence ? fenceUntrusted('evidence the run collected (tool results)', params.evidence) : '',
      'Build the complete artifact now.',
    ].filter(Boolean).join('\n\n'),
  }
}

/** The module in a reply: without a code fence (closed or not), and without any prose ahead of it. */
function stripToModule(text: string): string {
  const unfenced = text.trim().replace(/^```[a-z]*\s*\n/i, '').replace(/\n```\s*$/, '')
  const start = unfenced.search(/^(?:import\b|export\b|'use client'|"use client")/m)
  return start > 0 ? unfenced.slice(start) : unfenced
}

/**
 * Render the run's deliverable into a complete React artifact and return the
 * component source. Throws with the reason when the renderer produced nothing
 * usable — the caller records it and keeps the draft. A component that does
 * not compile gets one repair attempt with the compiler's message.
 */
export async function renderArtifact(params: { objective: string; request: string; draft: string; evidence: string; ledger?: LedgerContext }): Promise<string> {
  const { system, user } = buildArtifactRenderPrompt(params)
  let prompt = user
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { text, stopReason } = await generateLongText({ system, user: prompt, model: ARTIFACT_RENDER_MODEL, maxTokens: RENDER_MAX_TOKENS, surface: 'artifact_render', ledger: params.ledger, timeoutMs: 9 * 60_000 })
    // A module cut off at the output limit is not an artifact; keep the draft.
    if (stopReason === 'max_tokens') throw new Error('The rendered artifact ran past the output limit.')
    const component = reactComponentOf(stripToModule(text))
    if (!component) throw new Error(`The renderer did not return a React component (it began: ${JSON.stringify(text.trim().slice(0, 80))}).`)
    const compiled = compileArtifactPage(reactArtifactDocument(component))
    const failure = /could not be compiled: ([^"\\]+)/.exec(compiled)?.[1]
    if (!failure) return component
    prompt = `${user}\n\nYour previous component did not compile (${failure.slice(0, 300)}). Return the corrected complete component.`
  }
  throw new Error('The rendered artifact still did not compile after a repair attempt.')
}
