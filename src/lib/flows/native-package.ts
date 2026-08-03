import { z } from 'zod'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { redactHttpStepInput } from '@/features/flows/http'

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

export function portableFlowGraph(graph: FlowGraph): FlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.type === 'http'
      ? { ...node, data: redactHttpStepInput(node.data as Record<string, unknown>) } as typeof node
      : node),
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
