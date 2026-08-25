import type { FlowNode } from '@/lib/flows/graph'

/**
 * Current executable contract for every built-in node type.
 *
 * Keep this explicit: adding a node without registering its version is a build
 * error, and changing a version requires an interpreter branch plus a graph
 * migration. That prevents a deploy from silently reinterpreting saved flows.
 */
export const CURRENT_NODE_VERSIONS = {
  trigger: 1,
  agent: 1,
  condition: 1,
  loop: 1,
  parallel: 1,
  stop: 1,
  tool: 1,
  http: 1,
  transform: 1,
  filter: 1,
  switch: 1,
  variable: 1,
  data: 1,
  code: 1,
  humanReview: 1,
  output: 1,
  join: 1,
  ai: 1,
  subflow: 1,
  knowledge: 1,
  wait: 1,
  note: 1,
} as const satisfies Record<FlowNode['type'], number>

export function currentNodeVersion(type: FlowNode['type']): number {
  return CURRENT_NODE_VERSIONS[type]
}

export function effectiveNodeVersion(node: Pick<FlowNode, 'type' | 'typeVersion'>): number {
  return node.typeVersion ?? 1
}

export function nodeVersionProblem(node: Pick<FlowNode, 'type' | 'typeVersion'>): string | null {
  const actual = effectiveNodeVersion(node)
  const current = currentNodeVersion(node.type)
  if (actual > current) return `Node requires ${node.type} v${actual}, but this deployment supports through v${current}.`
  if (actual < 1) return `Node has invalid ${node.type} implementation version ${actual}.`
  return null
}
