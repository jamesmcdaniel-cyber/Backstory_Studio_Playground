import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { layoutGraph } from '@/lib/flows/layout'

/**
 * Export a flow to an n8n workflow JSON that imports into n8n (Workflows →
 * Import from File / paste). Structural nodes (trigger, HTTP, IF, Switch,
 * Filter, Set/Code) map to real n8n nodes and run after credentials are added;
 * steps with no n8n equivalent (agent/LLM, MCP/Nango tools, knowledge, subflow,
 * loop/parallel containers, human review) import as a No-Op placeholder carrying
 * a `notes` string that tells the builder exactly what to configure. Connections
 * and (best-effort) expression translation are preserved so the shape is intact.
 *
 * n8n connections are keyed by node NAME and reference target names, so names
 * are made unique here. Positions reuse our dagre layout (both are left-to-right).
 */

export type N8nNode = {
  parameters: Record<string, unknown>
  id: string
  name: string
  type: string
  typeVersion: number
  position: [number, number]
  notes?: string
}

export type N8nWorkflow = {
  name: string
  nodes: N8nNode[]
  connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }>
  settings: Record<string, unknown>
  meta: { exportedFrom: string }
}

/** Unique, n8n-safe display names, derived from the step label/type. */
function buildNameMap(graph: FlowGraph): Map<string, string> {
  const used = new Set<string>()
  const names = new Map<string, string>()
  for (const node of graph.nodes) {
    const base =
      node.type === 'trigger'
        ? 'Trigger'
        : ('label' in node.data && typeof node.data.label === 'string' && node.data.label.trim())
          ? node.data.label.trim()
          : node.type.charAt(0).toUpperCase() + node.type.slice(1)
    let name = base
    let i = 2
    while (used.has(name)) name = `${base} ${i++}`
    used.add(name)
    names.set(node.id, name)
  }
  return names
}

/**
 * Translate our `{{...}}` tokens into n8n expressions (best-effort — n8n prefixes
 * expressions with `=`). `{{step.<id>.output.field}}` → `={{ $node["Name"].json.field }}`,
 * `{{trigger.input.field}}` → `={{ $json.field }}`. Unknown tokens are left as a
 * literal so the user can fix them; a value with any token becomes an expression.
 */
export function translateTokens(value: string, names: Map<string, string>): string {
  if (!value || !value.includes('{{')) return value
  const expr = value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, path: string) => {
    const parts = path.split('.')
    // Our "incoming data" reference and n8n's $json mean the same thing: the
    // value entering the node.
    if (parts[0] === 'input') {
      const rest = parts.slice(1).join('.')
      return `{{ $json${rest ? '.' + rest : ''} }}`
    }
    if (parts[0] === 'trigger' && parts[1] === 'input') {
      const rest = parts.slice(2).join('.')
      return `{{ $json${rest ? '.' + rest : ''} }}`
    }
    if (parts[0] === 'step' && parts[1]) {
      const name = names.get(parts[1]) ?? parts[1]
      const rest = parts.slice(parts[2] === 'output' ? 3 : 2).join('.')
      return `{{ $node[${JSON.stringify(name)}].json${rest ? '.' + rest : ''} }}`
    }
    return `{{ /* ${path} */ }}`
  })
  return `=${expr}`
}

/** A No-Op placeholder carrying instructions for a step n8n can't run natively. */
function placeholder(note: string): { type: string; typeVersion: number; parameters: Record<string, unknown>; notes: string } {
  return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, notes: note }
}

/** Working credentials embedded at export time so the flow runs without the
 *  user hunting for them (the secret is minted fresh for the export). */
export type ExportCredentials = { triggerUrl: string; triggerSecret: string }

/** Map one flow node to its n8n type + parameters (+ optional note). */
function mapNode(node: FlowNode, names: Map<string, string>, credentials?: ExportCredentials): { type: string; typeVersion: number; parameters: Record<string, unknown>; notes?: string } {
  const tr = (v: unknown) => (typeof v === 'string' ? translateTokens(v, names) : v)
  switch (node.type) {
    case 'trigger': {
      const t = node.data.trigger?.type
      if (t === 'schedule') return { type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1, parameters: {}, notes: 'Set the schedule interval to match your flow.' }
      if (t === 'webhook') {
        return {
          type: 'n8n-nodes-base.webhook',
          typeVersion: 1,
          parameters: { httpMethod: 'POST', path: 'flow' },
          notes: credentials
            ? 'Point your caller at this webhook URL. To run the original flow on Backstory instead (or from a step below), POST to ' +
              `${credentials.triggerUrl} with header "x-trigger-secret: ${credentials.triggerSecret}" — this secret was minted for this export and is ready to use.`
            : 'Point your caller at this webhook URL.',
        }
      }
      return { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }
    }
    case 'http':
      return {
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4,
        parameters: {
          method: node.data.method ?? 'GET',
          url: tr(node.data.url ?? ''),
          ...(node.data.body ? { sendBody: true, jsonBody: tr(node.data.body), specifyBody: 'json' } : {}),
        },
        notes: 'Add any auth this API needs under Credentials.',
      }
    case 'condition':
      return {
        type: 'n8n-nodes-base.if',
        typeVersion: 2,
        parameters: {},
        notes: 'Recreate the condition(s) in the IF node. The “true” edge is output 1, “false” is output 2.',
      }
    case 'switch':
      return { type: 'n8n-nodes-base.switch', typeVersion: 3, parameters: {}, notes: 'Recreate each case as a Switch rule; the default is the fallback output.' }
    case 'filter':
      return { type: 'n8n-nodes-base.filter', typeVersion: 2, parameters: {}, notes: 'Recreate the pass condition — items that fail are dropped.' }
    case 'variable':
    case 'transform':
    case 'data':
      return { type: 'n8n-nodes-base.set', typeVersion: 3, parameters: {}, notes: `Recreate the “${node.type}” logic as Set/Edit-Fields (or a Code node for complex transforms).` }
    case 'code':
      return {
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: {
          mode: node.data.mode === 'each' ? 'runOnceForEachItem' : 'runOnceForAllItems',
          language: node.data.language === 'python' ? 'pythonNative' : 'javaScript',
          ...(node.data.language === 'python' ? { pythonCode: node.data.code } : { jsCode: node.data.code }),
        },
      }
    case 'agent':
      return placeholder(`AI agent step. In n8n, add an “AI Agent” node with an LLM (e.g. OpenAI) and paste this objective as the system/user prompt:\n${'input' in node.data ? (node.data.input ?? '') : ''}`)
    case 'ai':
      return placeholder(`AI step (${node.data.aiOp}). Use an OpenAI/LLM node; instructions: ${node.data.instructions ?? ''}`)
    case 'tool':
      return placeholder(`Tool call “${node.data.toolName}”. In n8n, use the matching app node (or an HTTP Request to the provider API) with the connected account.`)
    case 'knowledge':
      return placeholder(`Knowledge search “${node.data.query ?? ''}”. Replace with your vector-store / retrieval node.`)
    case 'subflow':
      return placeholder('Runs another flow. In n8n, use an “Execute Workflow” node pointing at the imported sub-workflow.')
    case 'humanReview':
      return placeholder('Human approval/input step. In n8n, use a “Wait” + form/approval, or send-and-wait.')
    case 'loop':
      return placeholder(`Loop over a list. In n8n, use “Loop Over Items (Split in Batches)”. Body steps: ${node.data.body.join(', ') || '(none)'}.`)
    case 'parallel':
      return placeholder('Parallel branches. In n8n, split into separate branches from the prior node and merge with a “Merge” node.')
    case 'join':
      return placeholder('Merge point — in n8n use a “Merge” node.')
    case 'output':
      return placeholder('Named outputs — in n8n, use a Set node to shape the final result.')
    case 'stop':
      return { type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {}, notes: 'Ends the flow here (no-op in n8n).' }
    default:
      return placeholder(`Step type “${(node as FlowNode).type}” — configure manually.`)
  }
}

/** The n8n output index a branch edge maps to (IF: true=0/false=1; else 0). */
function outputIndexFor(sourceType: string, branch: string | undefined): number {
  if (sourceType === 'condition') return branch === 'false' ? 1 : 0
  return 0
}

/** Convert a flow graph to an importable n8n workflow. */
export function flowToN8n(flow: { name?: string; graph: FlowGraph; credentials?: ExportCredentials }): N8nWorkflow {
  const graph = flow.graph
  const names = buildNameMap(graph)
  const positions = layoutGraph(graph)
  const containerMembers = new Set(
    graph.nodes.flatMap((n) => (n.type === 'loop' ? n.data.body : n.type === 'parallel' ? n.data.branches.flat() : [])),
  )

  const nodes: N8nNode[] = graph.nodes
    .filter((n) => !containerMembers.has(n.id)) // container bodies are summarized in the container's note
    .map((node) => {
      const mapped = mapNode(node, names, flow.credentials)
      const pos = positions.get(node.id) ?? { x: 0, y: 0 }
      return {
        parameters: mapped.parameters,
        id: node.id,
        name: names.get(node.id)!,
        type: mapped.type,
        typeVersion: mapped.typeVersion,
        position: [Math.round(pos.x), Math.round(pos.y)] as [number, number],
        ...(mapped.notes ? { notes: mapped.notes } : {}),
      }
    })

  const connections: N8nWorkflow['connections'] = {}
  for (const edge of graph.edges) {
    if (containerMembers.has(edge.source) || containerMembers.has(edge.target)) continue
    const sourceName = names.get(edge.source)
    const targetName = names.get(edge.target)
    const sourceNode = graph.nodes.find((n) => n.id === edge.source)
    if (!sourceName || !targetName || !sourceNode) continue
    const outIdx = outputIndexFor(sourceNode.type, edge.branch)
    const conn = (connections[sourceName] ??= { main: [] })
    while (conn.main.length <= outIdx) conn.main.push([])
    conn.main[outIdx].push({ node: targetName, type: 'main', index: 0 })
  }

  return {
    name: flow.name?.trim() || 'Exported flow',
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    meta: { exportedFrom: 'Backstory Studio' },
  }
}
