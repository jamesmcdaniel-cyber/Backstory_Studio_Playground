/**
 * What an imported flow is asking to be allowed to do.
 *
 * An imported workflow is executable code written by someone else. The import
 * screen used to report structural conversion notes — "this node type was
 * approximated" — which answers "will it work", not "what will it do with my
 * workspace's access". Those are different questions, and only the second one
 * matters when the author is a stranger.
 *
 * This produces the answer to the second: a plain-English list of the
 * capabilities the graph requests, so the importer approves an understood set
 * rather than a diagram.
 *
 * ── One analyzer, both import paths ────────────────────────────────────────
 *
 * Runs on the CONVERTED native graph, not on the source document. The n8n
 * importer and the native importer both produce a FlowGraph, so analysing that
 * covers both — and, more importantly, cannot drift from what will actually
 * execute. Reading the n8n JSON directly would describe the file rather than
 * the flow that gets created from it.
 */

import type { FlowGraph } from '@/lib/flows/graph'

export type CapabilityRisk = 'high' | 'medium' | 'low'

export interface FlowCapability {
  /** Stable machine key, e.g. `trigger.webhook`, `network.host`. */
  kind: string
  risk: CapabilityRisk
  /** One line, written for someone deciding whether to allow it. */
  title: string
  /** Why it carries risk — the sentence that makes the decision possible. */
  detail: string
  /** Distinct subjects: hosts, tool names, flow ids. */
  subjects: string[]
  /** Node ids requesting it, so the reviewer can find them. */
  nodeIds: string[]
}

const RISK_ORDER: Record<CapabilityRisk, number> = { high: 0, medium: 1, low: 2 }

/**
 * HTTP methods that change something in the remote system. A flow that only
 * reads is a fundamentally different proposition from one that writes, and
 * collapsing them into "makes network calls" throws away the distinction the
 * reviewer most needs.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Tool-name fragments implying a write. Provider-agnostic and deliberately
 * generous: a false positive costs one extra line on a review screen, a false
 * negative silently approves a flow that can send mail as you.
 */
const WRITE_TOOL_FRAGMENTS = [
  'create',
  'update',
  'delete',
  'send',
  'post',
  'write',
  'remove',
  'archive',
  'move',
  'upload',
  'invite',
  'assign',
  'close',
  'merge',
  'publish',
  'set',
  'add',
]

function isWriteToolName(name: string): boolean {
  const normalized = name.toLowerCase()
  return WRITE_TOOL_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

function hostOf(url: string): string | null {
  // Template-built URLs cannot be resolved statically. Reported as their own
  // capability rather than dropped — an unknowable destination is a finding,
  // not an absence of one.
  if (!url || url.includes('{{')) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

interface Accumulator {
  kind: string
  risk: CapabilityRisk
  title: string
  detail: string
  subjects: Set<string>
  nodeIds: Set<string>
}

/**
 * Analyse a converted graph and return every capability it requests.
 *
 * Returns an empty array for a flow that only transforms data it is given —
 * which is a real and reassuring answer, not a failure to analyse.
 */
export function extractFlowCapabilities(graph: FlowGraph): FlowCapability[] {
  const found = new Map<string, Accumulator>()

  const add = (
    kind: string,
    risk: CapabilityRisk,
    title: string,
    detail: string,
    subject: string | null,
    nodeId: string,
  ) => {
    const existing = found.get(kind)
    const entry = existing ?? {
      kind,
      risk,
      title,
      detail,
      subjects: new Set<string>(),
      nodeIds: new Set<string>(),
    }
    if (subject) entry.subjects.add(subject)
    entry.nodeIds.add(nodeId)
    found.set(kind, entry)
  }

  for (const node of graph.nodes ?? []) {
    const data = (node.data ?? {}) as Record<string, unknown>
    const id = node.id

    switch (node.type) {
      case 'trigger': {
        const trigger = (data.trigger ?? {}) as Record<string, unknown>
        const type = String(trigger.type ?? '')
        if (type === 'webhook') {
          add(
            'trigger.webhook',
            'high',
            'Runs from a public web address',
            'Anyone who learns the URL can start this flow, and it then runs with your ' +
              'workspace’s access. Publishing it mints a secret you must keep private.',
            // The n8n importer deliberately drops the source path — Backstory
            // mints its own trigger URL and secret — so there is usually no
            // subject to show. Better an empty list than a filler token.
            trigger.path ? String(trigger.path) : trigger.slug ? String(trigger.slug) : null,
            id,
          )
        } else if (type === 'schedule' || type === 'cron') {
          add(
            'trigger.schedule',
            'medium',
            'Runs on a schedule without anyone present',
            'It will act on its own, so a mistake repeats unattended rather than being ' +
              'noticed the one time someone runs it.',
            String(trigger.cadence ?? trigger.cron ?? 'schedule'),
            id,
          )
        }
        break
      }

      case 'http': {
        const url = String(data.url ?? '')
        const method = String(data.method ?? 'POST').toUpperCase()
        const host = hostOf(url)

        if (!host) {
          add(
            'network.dynamic',
            'high',
            'Calls a web address it builds while running',
            'The destination is not fixed in the flow, so what it contacts cannot be ' +
              'reviewed here — it depends on data the flow receives.',
            url.slice(0, 80) || 'dynamic URL',
            id,
          )
        } else if (WRITE_METHODS.has(method)) {
          add(
            'network.write',
            'high',
            'Sends data to outside systems',
            'These calls change or create data in another system rather than only reading it.',
            `${method} ${host}`,
            id,
          )
        } else {
          add(
            'network.read',
            'low',
            'Reads from outside systems',
            'Fetches data from these addresses. It does not change anything there.',
            host,
            id,
          )
        }

        if (data.credentialId || data.connectionId) {
          add(
            'credential.use',
            'high',
            'Authenticates as one of your connected accounts',
            'Steps here attach a saved credential, so anything they do is done as the ' +
              'account that owns it — and is attributed to that person.',
            host ?? 'stored credential',
            id,
          )
        }
        break
      }

      case 'tool': {
        const toolName = String(data.toolName ?? '')
        const write = isWriteToolName(toolName)
        add(
          write ? 'tool.write' : 'tool.read',
          write ? 'high' : 'medium',
          write ? 'Uses tools that change data' : 'Uses tools that read data',
          write
            ? 'These tools act in connected systems on your behalf — creating, sending ' +
              'or deleting, not just looking.'
            : 'These tools read from connected systems using your workspace’s access.',
          toolName || 'tool',
          id,
        )
        if (data.connectionId) {
          add(
            'credential.use',
            'high',
            'Authenticates as one of your connected accounts',
            'Steps here attach a saved credential, so anything they do is done as the ' +
              'account that owns it — and is attributed to that person.',
            String(data.connectionId),
            id,
          )
        }
        break
      }

      case 'code': {
        add(
          'code.execute',
          'medium',
          'Runs code supplied with the flow',
          'The code runs sandboxed with no network or file access, but it does see the ' +
            'data flowing through the steps around it.',
          String(data.language ?? 'javascript'),
          id,
        )
        break
      }

      case 'agent':
      case 'ai': {
        add(
          'ai.model',
          'medium',
          'Sends data to an AI model',
          'Content passing through these steps is sent to a model provider to be processed.',
          String(data.model ?? data.agentId ?? 'model'),
          id,
        )
        break
      }

      case 'subflow': {
        add(
          'flow.subflow',
          'medium',
          'Runs other flows',
          'It calls another flow, which carries its own permissions — review that one too.',
          String(data.flowId ?? 'subflow'),
          id,
        )
        break
      }

      case 'knowledge': {
        add(
          'data.knowledge',
          'medium',
          'Reads your workspace knowledge base',
          'It can retrieve documents your workspace has uploaded.',
          'knowledge base',
          id,
        )
        break
      }

      default:
        break
    }
  }

  return [...found.values()]
    .map((entry) => ({
      kind: entry.kind,
      risk: entry.risk,
      title: entry.title,
      detail: entry.detail,
      subjects: [...entry.subjects].sort(),
      nodeIds: [...entry.nodeIds],
    }))
    // Highest risk first: a review screen is read top-down and often not to the
    // bottom, so the ordering decides what actually gets considered.
    .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.kind.localeCompare(b.kind))
}

/**
 * True when a flow requests anything worth a human decision.
 *
 * Read-only network access alone does not qualify: prompting on every import
 * trains people to click through, which costs more than it protects.
 */
export function requiresCapabilityReview(capabilities: FlowCapability[]): boolean {
  return capabilities.some((capability) => capability.risk === 'high')
}

/** One-line summary for a confirm dialog or an audit entry. */
export function summarizeCapabilities(capabilities: FlowCapability[]): string {
  if (capabilities.length === 0) return 'This flow only transforms data it is given.'
  const high = capabilities.filter((capability) => capability.risk === 'high')
  const lead = (high.length ? high : capabilities).map((capability) => capability.title.toLowerCase())
  return `This flow ${lead.slice(0, 3).join(', ')}${lead.length > 3 ? `, and ${lead.length - 3} more` : ''}.`
}
