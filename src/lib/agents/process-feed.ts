/**
 * Pure event→timeline shaping for an agent execution's process feed, shared by
 * the dashboard activity pane (full timeline cards) and the flow runs panel
 * (compact live feed). Input is the wire shape of GET /api/workflows/executions
 * (`items[n].events` + `items[n].steps`); no React or fetch in here.
 */

import { humanizeToolName } from '@/lib/flows/humanize-tool-name'

export type ProcessEvent = { id: string; kind: string; payload?: any; ts: string }

/** One tool-call step of an execution (a WorkflowStep row on the wire). */
export type ProcessToolStep = {
  id: string
  node: string
  status: string
  input?: any
  output?: any
  error?: any
  startedAt?: string | null
  completedAt?: string | null
}

export type ContextFact = { type: string; text: string }

export type SuggestionItem = { memoryId: string; title: string; rationale: string; actionType: string }

// Merge thinking events and tool-call steps into one chronological process
// timeline, so the log reads as the agent's reasoning interleaved with its calls.
export type TimelineItem =
  | { key: string; ts: number; kind: 'thinking'; text: string }
  | { key: string; ts: number; kind: 'tool'; step: ProcessToolStep }
  | { key: string; ts: number; kind: 'context'; summary: string; hits: ContextFact[]; related: ContextFact[] }
  | { key: string; ts: number; kind: 'knowledge'; summary: string; documents: Array<{ id: string; filename: string }> }
  | { key: string; ts: number; kind: 'plan'; text: string }
  | { key: string; ts: number; kind: 'memory'; summary: string }
  | { key: string; ts: number; kind: 'autoanswer'; question: string; answer: string }

export function buildProcessTimeline(
  events: ProcessEvent[],
  steps: ProcessToolStep[],
): { items: TimelineItem[]; suggestions: SuggestionItem[] } {
  const items: TimelineItem[] = []
  const suggestionsById = new Map<string, SuggestionItem>()
  for (const event of events ?? []) {
    if (event.kind === 'agent.thinking' && event.payload?.text) {
      items.push({ key: `t-${event.id}`, ts: new Date(event.ts).getTime(), kind: 'thinking', text: String(event.payload.text) })
    }
    if (event.kind === 'context.retrieved') {
      items.push({
        key: `c-${event.id}`,
        ts: new Date(event.ts).getTime(),
        kind: 'context',
        summary: String(event.payload?.summary ?? 'Retrieved correlated context'),
        hits: Array.isArray(event.payload?.hits) ? (event.payload.hits as ContextFact[]) : [],
        related: Array.isArray(event.payload?.related) ? (event.payload.related as ContextFact[]) : [],
      })
    }
    if (event.kind === 'knowledge.available' || event.kind === 'knowledge.retrieved') {
      // Offered vs actually drawn on — both matter to a reader asking "did it
      // know the document was there, and did it open it?". `documents` carries
      // resolvable ids so the pane can link straight to the source.
      const documents = Array.isArray(event.payload?.documents)
        ? (event.payload.documents as Array<{ id?: unknown; filename?: unknown }>)
            .filter((doc) => typeof doc?.id === 'string' && typeof doc?.filename === 'string')
            .map((doc) => ({ id: String(doc.id), filename: String(doc.filename) }))
        : []
      items.push({
        key: `k-${event.id}`,
        ts: new Date(event.ts).getTime(),
        kind: 'knowledge',
        summary: String(event.payload?.summary ?? 'Used the repository'),
        documents,
      })
    }
    if (event.kind === 'agent.plan' && event.payload?.text) {
      items.push({ key: `p-${event.id}`, ts: new Date(event.ts).getTime(), kind: 'plan', text: String(event.payload.text) })
    }
    if (event.kind === 'memory.retrieved' && event.payload?.summary) {
      items.push({ key: `m-${event.id}`, ts: new Date(event.ts).getTime(), kind: 'memory', summary: String(event.payload.summary) })
    }
    if (event.kind === 'agent.question.autoanswered') {
      items.push({
        key: `a-${event.id}`,
        ts: new Date(event.ts).getTime(),
        kind: 'autoanswer',
        question: String(event.payload?.question ?? ''),
        answer: String(event.payload?.answer ?? ''),
      })
    }
    if (event.kind === 'agent.suggestion' && event.payload?.memoryId) {
      suggestionsById.set(String(event.payload.memoryId), {
        memoryId: String(event.payload.memoryId),
        title: String(event.payload.title ?? ''),
        rationale: String(event.payload.rationale ?? ''),
        actionType: String(event.payload.actionType ?? ''),
      })
    }
  }
  for (const step of steps ?? []) {
    const ts = step.startedAt ? new Date(step.startedAt).getTime() : 0
    items.push({ key: `s-${step.id}`, ts, kind: 'tool', step })
  }
  return { items: items.sort((a, b) => a.ts - b.ts), suggestions: [...suggestionsById.values()] }
}

// ── Compact feed (flow runs panel) ───────────────────────────────────────────
// One plain-english line per timeline item, for surfaces too small for the
// full card timeline. Copy stays free of raw identifiers where possible: a
// tool node like "nango:slack.send_message" reads as "send message in Slack".

export type ProcessFeedRow = { key: string; ts: number; label: string }

/** Collapse whitespace and bound the length so a feed row stays one line. */
function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase())
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

/**
 * "nango:slack.send_message" → "send message in Slack". The internal plane
 * prefix is dropped, and so is the provider word a tool name repeats
 * ("gmail.gmail_send_email"), so the phrase names the provider exactly once.
 */
function toolPhrase(node: string): string {
  const cleaned = node.replace(/^nango:/, '')
  const dot = cleaned.indexOf('.')
  if (dot === -1) return lowerFirst(humanizeToolName(cleaned) || cleaned)
  const providerKey = cleaned.slice(0, dot)
  const provider = titleCase(providerKey.replace(/[_-]+/g, ' '))
  // Multi-dot tool paths (google.calendar.create_event) read as words too.
  const tool = lowerFirst(humanizeToolName(cleaned.slice(dot + 1).replace(/\./g, ' '), providerKey) || cleaned)
  return provider ? `${tool} in ${provider}` : tool
}

function toolLabel(step: ProcessToolStep): string {
  if (step.node === 'ask_user') {
    return step.status === 'succeeded' ? 'Got your answer' : 'Asking you a question'
  }
  const phrase = toolPhrase(step.node)
  switch (step.status) {
    case 'running':
      return `Calling ${phrase}`
    case 'waiting':
      return `Waiting on ${phrase}`
    case 'failed':
      return `Call to ${phrase} failed`
    default:
      return `Finished ${phrase}`
  }
}

export function feedLabel(item: TimelineItem): string {
  switch (item.kind) {
    case 'thinking':
      return `Thinking — ${snippet(item.text)}`
    case 'plan':
      return `Made a plan — ${snippet(item.text)}`
    case 'context':
      return snippet(item.summary)
    case 'knowledge':
      return snippet(item.summary)
    case 'memory':
      return `Recalled from memory — ${snippet(item.summary)}`
    case 'autoanswer':
      return 'Answered a question from memory'
    case 'tool':
      return toolLabel(item.step)
  }
}

/** The last `limit` timeline items as one-line plain-english rows. */
export function processFeedRows(items: TimelineItem[], limit = 6): ProcessFeedRow[] {
  return items.slice(-limit).map((item) => ({ key: item.key, ts: item.ts, label: feedLabel(item) }))
}
