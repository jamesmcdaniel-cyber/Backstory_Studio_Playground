import { asStructured } from '@/features/flows/context'

/**
 * Multi-input merge helpers for the `join` node's merge modes (n8n Merge parity,
 * minus the SQL/cartesian modes we deliberately skip). Pure — the interpreter
 * gathers each active incoming branch's output and hands them here in edge order.
 */

/** Coerce one branch output to a list: an array stays as-is; anything else
 *  becomes a single-item list (a JSON-string array is parsed by asStructured). */
function asItems(value: unknown): unknown[] {
  const structured = asStructured(value)
  return Array.isArray(structured) ? structured : [structured]
}

/** append: concatenate every branch's items into one flat list. */
export function mergeAppend(inputs: unknown[]): unknown[] {
  return inputs.flatMap(asItems)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

/**
 * combineByKey: full outer join of record lists on a shared `key` field. Records
 * that share a key value are shallow-merged into one (later inputs win);
 * records missing the key stand alone. First-seen key order is preserved.
 */
export function mergeByKey(inputs: unknown[], key: string | undefined): unknown[] {
  const field = (key ?? '').trim()
  if (!field) return mergeAppend(inputs)
  const order: string[] = []
  const byKey = new Map<string, Record<string, unknown>>()
  const loose: unknown[] = []
  for (const input of inputs) {
    for (const item of asItems(input)) {
      if (!isRecord(item) || item[field] === undefined || item[field] === null) {
        loose.push(item)
        continue
      }
      const id = String(item[field])
      const existing = byKey.get(id)
      if (existing) {
        byKey.set(id, { ...existing, ...item })
      } else {
        byKey.set(id, { ...item })
        order.push(id)
      }
    }
  }
  return [...order.map((id) => byKey.get(id)!), ...loose]
}
