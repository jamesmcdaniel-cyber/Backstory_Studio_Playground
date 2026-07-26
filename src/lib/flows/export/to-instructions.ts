import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import { stepLabelsOf } from '@/lib/flows/token-text'

/**
 * Export a flow as plain-English, copilot-ready instructions. Zapier, Workato,
 * Make, and n8n all now have AI builders that turn a natural-language
 * description into a working automation — this produces exactly that: a
 * sequential, intent-first description of what the automation should do, with
 * data flow spelled out in words (not our {{token}} syntax). Paste it into the
 * target platform's AI builder, or follow it by hand.
 *
 * Pure and dependency-light so it's unit-testable.
 */

/** Turn `{{...}}` references into plain English so a copilot understands them. */
function describeTokens(text: string, labels: Record<string, string>): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, path: string) => {
    const parts = path.split('.')
    if (parts[0] === 'trigger' && parts[1] === 'input') {
      const field = parts.slice(2).join(' ')
      return field ? `the “${field}” from the trigger data` : 'the trigger data'
    }
    if (parts[0] === 'step' && parts[1]) {
      const label = labels[parts[1]] || `step ${parts[1]}`
      const field = parts.slice(parts[2] === 'output' ? 3 : 2).join(' ')
      return field ? `the “${field}” from “${label}”` : `the result of “${label}”`
    }
    if (parts[0] === 'steps') return 'the combined data from all earlier steps'
    if (parts[0] === 'item') return 'the current item'
    if (parts[0] === 'now') return "the current date/time"
    return `the value “${path}”`
  })
}

const clip = (s: string, n = 240) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** One plain-English sentence describing what a step does. */
function describeStep(node: FlowNode, labels: Record<string, string>): string {
  const d = describeTokens
  switch (node.type) {
    case 'agent':
      return `Use an AI agent to do this: ${clip(d(node.data.input ?? 'work on the incoming data', labels))}`
    case 'ai':
      return `Use AI to ${node.data.aiOp} — ${clip(d(node.data.instructions || node.data.input || '', labels)) || 'process the incoming data'}.`
    case 'http':
      return `Call an API: ${node.data.method ?? 'GET'} ${d(node.data.url ?? '', labels)}.`
    case 'tool':
      return `Use the ${node.data.toolName || 'connected'} action (via your connected account).`
    case 'condition': {
      const c = node.data.clauses?.[0]
      const cond = c ? `${d(c.left, labels)} ${c.op} ${d(c.right, labels)}` : 'the condition holds'
      return `If ${cond}, continue down the “yes” path; otherwise take the “no” path.`
    }
    case 'switch':
      return `Route to a different path depending on the incoming data (${node.data.cases.length} case${node.data.cases.length === 1 ? '' : 's'} plus a default).`
    case 'filter':
      return `Only continue when the incoming data matches the filter; otherwise stop this path.`
    case 'loop':
      return `For each item in ${d(node.data.over, labels)}, run the steps inside the loop.`
    case 'parallel':
      return `Run ${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'} in parallel, then continue.`
    case 'transform':
      return `Reshape the data into new fields.`
    case 'data':
      return `Transform the data (${node.data.op}).`
    case 'code':
      return `Run this custom ${node.data.language === 'python' ? 'Python' : 'JavaScript'} code: ${clip(node.data.code)}`
    case 'variable':
      return `Set/update a working value named “${node.data.name || 'variable'}”.`
    case 'knowledge':
      return `Search your knowledge base for ${d(node.data.query ?? '', labels) || 'relevant documents'}.`
    case 'subflow':
      return `Run another automation as a sub-step and use its result.`
    case 'humanReview':
      return `Pause and ask a person: ${clip(d(node.data.message ?? 'please review', labels))}`
    case 'output':
      return `Produce the final result${node.data.outputs?.length ? `: ${node.data.outputs.map((o) => o.name).join(', ')}` : ''}.`
    case 'join':
      return `Merge the branches back into one path.`
    case 'stop':
      return `Stop the automation here.`
    default:
      return `Run the “${node.type}” step.`
  }
}

function describeTrigger(node: FlowNode | undefined): string {
  const t = node && node.type === 'trigger' ? node.data.trigger?.type : 'manual'
  if (t === 'schedule') return 'Runs on a schedule.'
  if (t === 'webhook') return 'Runs when it receives a webhook (incoming HTTP request with data).'
  if (t === 'signal') return 'Runs when triggered by another automation’s event.'
  return 'Runs on demand (manually / when you start it).'
}

/** Topological-ish order from the trigger over the outer DAG (containers excluded). */
function orderedSteps(graph: FlowGraph): FlowNode[] {
  const contained = new Set(graph.nodes.flatMap((n) => (n.type === 'loop' ? n.data.body : n.type === 'parallel' ? n.data.branches.flat() : [])))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out: FlowNode[] = []
  const seen = new Set<string>()
  const queue = [byId.get('trigger')?.id ?? graph.nodes[0]?.id].filter(Boolean) as string[]
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id) || contained.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node && node.type !== 'trigger') out.push(node)
    for (const edge of graph.edges) if (edge.source === id && !seen.has(edge.target)) queue.push(edge.target)
  }
  // Append any steps not reachable from the trigger, so nothing is silently dropped.
  for (const node of graph.nodes) if (!seen.has(node.id) && node.type !== 'trigger' && !contained.has(node.id)) out.push(node)
  return out
}

/** Build the copilot-ready instructions (Markdown) for a flow. */
export function flowToInstructions(
  flow: { name?: string; description?: string; graph: FlowGraph; credentials?: { triggerUrl: string; triggerSecret: string } },
  agents?: { id: string; title: string }[],
): string {
  const graph = flow.graph
  const labels = stepLabelsOf(graph, agents)
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  const steps = orderedSteps(graph)

  const integrations = Array.from(new Set(
    graph.nodes.flatMap((n) => (n.type === 'tool' && n.data.toolName ? [n.data.toolName] : n.type === 'http' ? ['an HTTP API'] : [])),
  ))

  const lines: string[] = []
  lines.push(`# ${flow.name?.trim() || 'Automation'}`)
  lines.push('')
  lines.push('_Paste this into your automation platform’s AI builder (Zapier, Workato, Make, or n8n) to recreate it, or follow it step by step._')
  lines.push('')
  if (flow.description?.trim()) { lines.push(flow.description.trim()); lines.push('') }
  lines.push('## Trigger')
  lines.push(describeTrigger(trigger))
  lines.push('')
  lines.push('## Steps')
  if (steps.length === 0) lines.push('_(no steps yet)_')
  steps.forEach((node, i) => {
    const label = labels[node.id] || node.type
    lines.push(`${i + 1}. **${label}** — ${describeStep(node, labels)}`)
  })
  lines.push('')
  if (integrations.length) {
    lines.push('## Connections you’ll need')
    for (const name of integrations) lines.push(`- ${name}`)
    lines.push('')
  }
  if (flow.credentials) {
    lines.push('## Credentials (ready to use)')
    lines.push(`- Trigger URL: \`${flow.credentials.triggerUrl}\``)
    lines.push(`- Trigger secret: \`${flow.credentials.triggerSecret}\` (send as the \`x-trigger-secret\` header)`)
    lines.push('- These were minted for this export — the flow can be triggered on Backstory with them as-is, no extra setup.')
    lines.push('')
  }
  lines.push('## Notes')
  lines.push('- AI-agent steps: recreate with the platform’s AI/LLM action and paste the described objective as the prompt.')
  lines.push('- Data flow: wherever a step says “the result of …”, map that step’s output into the field on the target platform.')
  return lines.join('\n')
}
