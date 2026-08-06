import type { FlowNode } from '@/lib/flows/graph'

/**
 * The single source of truth for which optional "advanced" parameters each
 * node type supports. Powers the MS-style "Advanced parameters — Showing N of
 * M" section on step cards and in the settings drawer.
 */
export type AdvancedParamKey =
  | 'onError'
  | 'retries'
  | 'timeoutMs'
  | 'bodyMode'
  | 'responseType'
  | 'failOnHttpError'
  | 'concurrency'
  | 'retryDelayMs'
  | 'alwaysOutputData'
  | 'maxRedirects'
  | 'batchSize'
  | 'waitForCompletion'

const BY_TYPE: Partial<Record<FlowNode['type'], AdvancedParamKey[]>> = {
  agent: ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData'],
  ai: ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData'],
  subflow: ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'waitForCompletion', 'alwaysOutputData'],
  tool: ['onError', 'retries', 'retryDelayMs', 'timeoutMs', 'alwaysOutputData'],
  http: ['responseType', 'failOnHttpError', 'onError', 'retries', 'retryDelayMs', 'timeoutMs', 'maxRedirects', 'alwaysOutputData'],
  // No alwaysOutputData: the code schema doesn't store it and the interpreter
  // never passes it — offering it was a dead toggle.
  code: ['onError', 'timeoutMs'],
  loop: ['concurrency', 'batchSize'],
}

export function advancedParamKeys(type: FlowNode['type']): AdvancedParamKey[] {
  return BY_TYPE[type] ?? []
}

/** How many of the node's advanced params are explicitly set. */
export function advancedParamsSetCount(node: FlowNode): number {
  const data = node.data as Record<string, unknown>
  return advancedParamKeys(node.type).filter((key) => data[key] !== undefined).length
}
