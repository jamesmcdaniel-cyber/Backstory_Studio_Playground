import type { FlowGraph, FlowNode } from '@/lib/flows/graph'
import type { FlowValidationResult } from '@/lib/flows/validate'
import { NATIVE_FLOW_FORMAT, portableFlowGraph, type NativeFlowPackage } from '@/lib/flows/native-package'

/**
 * The debug export: a normal native flow package with the builder's current
 * validation findings embedded under `debug`, so the file can be handed to an
 * LLM (or a colleague) with everything needed to fix the flow in one place.
 *
 * Round-trip safety: `nativeFlowPackageSchema` is a non-strict object, so the
 * extra `debug` key is silently stripped when the file is imported back —
 * the fixed file needs no manual cleanup before re-upload.
 */

export type FlowDebugIssue = {
  level: 'error' | 'warning'
  code: string
  message: string
  /** The offending step, when the issue is step-scoped. */
  nodeId?: string
  /** That step's display label + type, so the reader needn't cross-reference. */
  step?: string
}

export type FlowDebugPackage = NativeFlowPackage & {
  debug: {
    issues: FlowDebugIssue[]
    summary: string
    /** How an assistant should edit the file — written for the LLM it's pasted into. */
    assistantInstructions: string
  }
}

function stepLabel(node: FlowNode | undefined): string | undefined {
  if (!node) return undefined
  const label = 'label' in node.data && typeof node.data.label === 'string' ? node.data.label.trim() : ''
  return label ? `${label} (${node.type})` : node.type
}

const ASSISTANT_INSTRUCTIONS = [
  'This file is a Backstory flow export. `flow.graph.nodes` are the steps and `flow.graph.edges` connect them by node id.',
  'The problems to fix are listed in `debug.issues` — each names the offending node id where the issue is step-scoped.',
  'Fix the issues by editing `flow.graph` only: correct step data, ids, and edges. Keep every node\'s `type` one of the existing types in the file, keep `format` unchanged, and keep ids referenced by edges consistent.',
  'Do not invent agent ids, tool-connection ids, or credential ids — if an issue says one is missing or unknown, leave the field empty or add a note in the step\'s `note` field for the flow owner to fill in.',
  'Return the complete corrected JSON document in the same structure. The `debug` block is ignored on re-import, so it may be left in place or removed.',
].join(' ')

export function flowToDebugPackage(
  flow: { name: string; description: string; folder: string; visibility: string; graph: FlowGraph },
  validation: FlowValidationResult,
): FlowDebugPackage {
  const byId = new Map(flow.graph.nodes.map((node) => [node.id, node]))
  const issues: FlowDebugIssue[] = validation.issues.map((issue) => ({
    level: issue.level,
    code: issue.code,
    message: issue.message,
    ...(issue.nodeId ? { nodeId: issue.nodeId, step: stepLabel(byId.get(issue.nodeId)) } : {}),
  }))
  const errors = validation.errors.length
  const warnings = validation.warnings.length
  return {
    format: NATIVE_FLOW_FORMAT,
    flow: {
      name: flow.name,
      description: flow.description,
      folder: flow.folder,
      visibility: flow.visibility === 'private' || flow.visibility === 'view' ? flow.visibility : 'shared',
      graph: portableFlowGraph(flow.graph),
    },
    debug: {
      issues,
      summary: errors === 0 && warnings === 0
        ? 'The flow checker found no problems in this flow.'
        : `The flow checker found ${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} in this flow.`,
      assistantInstructions: ASSISTANT_INSTRUCTIONS,
    },
  }
}
