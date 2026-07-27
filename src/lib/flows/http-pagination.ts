/**
 * Pure helpers for the HTTP node's pagination and "optimize response for AI"
 * options (n8n parity). The fetch loop lives in the HTTP adapter (execute-flow),
 * which re-runs the SSRF guard per page; everything path/shape-related is here
 * and unit-tested.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/** Read a dot-path (array indices allowed) out of a value; undefined if absent. */
export function getByPath(value: unknown, path: string | undefined): unknown {
  if (!path || !path.trim()) return value
  let current: unknown = value
  for (const part of path.split('.')) {
    if (current == null) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (isRecord(current)) {
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}

/** Set (or replace) one query parameter on a URL. */
export function setQueryParam(url: string, param: string, value: string | number): string {
  const next = new URL(url)
  next.searchParams.set(param, String(value))
  return next.toString()
}

const LIST_KEYS = ['items', 'data', 'results', 'records', 'value', 'rows']

/** Extract the list from a page: an explicit path, else the body if it's an
 *  array, else a list found under a common key. Empty list if none. */
export function pageItems(body: unknown, itemsPath: string | undefined): unknown[] {
  if (itemsPath && itemsPath.trim()) {
    const found = getByPath(body, itemsPath)
    return Array.isArray(found) ? found : []
  }
  if (Array.isArray(body)) return body
  if (isRecord(body)) {
    for (const key of LIST_KEYS) {
      if (Array.isArray(body[key])) return body[key] as unknown[]
    }
  }
  return []
}

export type OptimizeForAiOptions = {
  /** Drill into this dot-path first (e.g. the list within an envelope). */
  dataPath?: string
  /** Keep only these fields of each record (records only; scalars pass through). */
  fields?: string[]
  /** Cap a list to this many items. */
  maxItems?: number
}

/** Trim a response for agent consumption: drill in, project fields, cap length. */
export function optimizeForAi(body: unknown, opts: OptimizeForAiOptions): unknown {
  let value = opts.dataPath ? getByPath(body, opts.dataPath) : body
  const fields = (opts.fields ?? []).filter((field) => field.trim())
  if (fields.length && Array.isArray(value)) {
    value = value.map((item) =>
      isRecord(item) ? Object.fromEntries(fields.filter((f) => f in item).map((f) => [f, item[f]])) : item,
    )
  } else if (fields.length && isRecord(value)) {
    const record = value
    value = Object.fromEntries(fields.filter((f) => f in record).map((f) => [f, record[f]]))
  }
  if (opts.maxItems && opts.maxItems > 0 && Array.isArray(value)) {
    value = value.slice(0, opts.maxItems)
  }
  return value
}
