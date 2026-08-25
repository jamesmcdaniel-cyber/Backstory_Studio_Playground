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

/** One set parameter, described the way the panel says it. */
export type AdvancedParamSummaryEntry = { key: AdvancedParamKey; text: string }

function seconds(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : null
}

function describe(key: AdvancedParamKey, value: unknown): string | null {
  switch (key) {
    case 'onError':
      return value === 'continue'
        ? 'Continues on error'
        : value === 'route'
          ? 'Routes failures to an error path'
          : value === 'stop'
            ? 'Stops the flow on error'
            : null
    case 'retries':
      if (typeof value !== 'number') return null
      return value === 0 ? 'No retries' : value === 1 ? '1 retry' : `${value} retries`
    case 'retryDelayMs': {
      const s = seconds(value)
      return s && `Waits ${s} between tries`
    }
    case 'timeoutMs': {
      const s = seconds(value)
      return s && `Timeout ${s}`
    }
    case 'bodyMode':
      return value === 'json' ? 'JSON body' : value === 'text' ? 'Text body' : value === 'none' ? 'No body' : null
    case 'responseType':
      return value === 'file'
        ? 'Downloads the response as a file'
        : value === 'json'
          ? 'Response parsed as JSON'
          : value === 'text'
            ? 'Response parsed as text'
            : value === 'auto'
              ? 'Response parsed automatically'
              : null
    case 'failOnHttpError':
      return value === false ? 'Returns 4xx/5xx responses' : value === true ? 'Fails on 4xx/5xx' : null
    case 'concurrency':
      return typeof value === 'number' ? `${value} at a time` : null
    case 'alwaysOutputData':
      return value === true ? 'Always outputs data' : value === false ? 'Skips downstream steps when empty' : null
    case 'maxRedirects':
      return typeof value === 'number'
        ? value === 0 ? 'Does not follow redirects' : `Follows up to ${value} redirects`
        : null
    case 'batchSize':
      return typeof value === 'number' ? `${value} items per round` : null
    case 'waitForCompletion':
      return value === false ? 'Does not wait for the other flow' : value === true ? 'Waits for the other flow' : null
  }
}

/**
 * The node's advanced parameters that are actually SET, each in plain English.
 *
 * The section header could only count them ("Showing 2 of 8"), which meant the
 * settings in force — a step that swallows its errors, one that gives up after
 * 5 seconds — were invisible unless you expanded it. A count tells you that
 * something was changed; it never tells you what now happens.
 *
 * Ordered by the manifest so the summary reads the same way twice, regardless
 * of the order the keys happen to sit in on the stored node.
 */
export function advancedParamSummary(node: FlowNode): AdvancedParamSummaryEntry[] {
  const data = node.data as Record<string, unknown>
  const entries: AdvancedParamSummaryEntry[] = []
  for (const key of advancedParamKeys(node.type)) {
    if (data[key] === undefined) continue
    const text = describe(key, data[key])
    if (text) entries.push({ key, text })
  }
  return entries
}
