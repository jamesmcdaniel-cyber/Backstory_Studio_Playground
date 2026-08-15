import { z } from 'zod'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { redactFlowValue } from '@/lib/flows/secret-redaction'

export const NATIVE_FLOW_FORMAT = 'backstory.flow.v1' as const

export const nativeFlowPackageSchema = z.object({
  format: z.literal(NATIVE_FLOW_FORMAT),
  flow: z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(10_000).default(''),
    folder: z.string().max(60).default(''),
    visibility: z.enum(['shared', 'private', 'view']).default('shared'),
    graph: flowGraphSchema,
  }),
})

export type NativeFlowPackage = z.infer<typeof nativeFlowPackageSchema>

/**
 * The graph as it may leave this workspace: exported, published to the
 * catalogue, or handed to the public API.
 *
 * This used to redact the `headers` field of `http` nodes and nothing else —
 * an allowlist of one field on one of twenty-two node types. The same http node
 * carries free-text `url`, `query` and `body`, so a key in a query string
 * exported verbatim, and `code` nodes exported up to 100KB of user source
 * untouched.
 *
 * Now every node is walked and redacted by value shape and field name, so a
 * credential is removed wherever an author happened to put it. Template
 * references survive, so the exported flow still describes what it does and can
 * be imported and re-bound to the importer's own credentials.
 */
export function portableFlowGraph(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      data: redactFlowValue(node.data),
    })) as FlowGraph['nodes'],
  }
}

export function nativeFlowPackage(flow: { name: string; description: string | null; folder: string; visibility: string; graph: unknown }): NativeFlowPackage {
  const graph = flowGraphSchema.parse(flow.graph)
  return {
    format: NATIVE_FLOW_FORMAT,
    flow: {
      name: flow.name,
      description: flow.description ?? '',
      folder: flow.folder ?? '',
      visibility: flow.visibility === 'private' || flow.visibility === 'view' ? flow.visibility : 'shared',
      graph: portableFlowGraph(graph),
    },
  }
}
