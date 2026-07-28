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
export function mergeByKey(inputs: unknown[], key: string | undefined, includeUnpaired = true): unknown[] {
  const field = (key ?? '').trim()
  if (!field) return mergeAppend(inputs)
  const order: string[] = []
  const byKey = new Map<string, Record<string, unknown>>()
  const seenIn = new Map<string, number>()
  const loose: unknown[] = []
  for (const input of inputs) {
    const keysThisInput = new Set<string>()
    for (const item of asItems(input)) {
      if (!isRecord(item) || item[field] === undefined || item[field] === null) {
        loose.push(item)
        continue
      }
      const id = String(item[field])
      if (!keysThisInput.has(id)) {
        keysThisInput.add(id)
        seenIn.set(id, (seenIn.get(id) ?? 0) + 1)
      }
      const existing = byKey.get(id)
      if (existing) {
        byKey.set(id, { ...existing, ...item })
      } else {
        byKey.set(id, { ...item })
        order.push(id)
      }
    }
  }
  // A key value seen in only ONE input is unpaired; `includeUnpaired` decides
  // whether those and the keyless `loose` records survive the join.
  const joined = order.map((id) => byKey.get(id)!)
  if (includeUnpaired) return [...joined, ...loose]
  return joined.filter((record) => (seenIn.get(String(record[field])) ?? 0) > 1)
}

/**
 * combineByPosition: pair the Nth item of every input into one record
 * (n8n's "Combine by Position"). Shorter inputs contribute nothing to the
 * positions they lack — with `includeUnpaired`, the longer input's extra items
 * still come through on their own rather than being dropped.
 */
export function mergeByPosition(inputs: unknown[], includeUnpaired = false): unknown[] {
  const lists = inputs.map(asItems)
  if (!lists.length) return []
  const longest = Math.max(...lists.map((list) => list.length))
  const shortest = Math.min(...lists.map((list) => list.length))
  const paired: unknown[] = []
  const limit = includeUnpaired ? longest : shortest
  for (let i = 0; i < limit; i += 1) {
    const parts = lists.map((list) => list[i]).filter((value) => value !== undefined)
    if (!parts.length) continue
    // Records merge into one; anything non-record keeps the last value at that
    // position, since there is no sensible way to shallow-merge scalars.
    if (parts.every(isRecord)) paired.push(Object.assign({}, ...(parts as Record<string, unknown>[])))
    else paired.push(parts.length === 1 ? parts[0] : parts[parts.length - 1])
  }
  return paired
}

/**
 * allCombinations: the cross product of every input's items (n8n's "All
 * Combinations"). Records at each position are shallow-merged; the result grows
 * multiplicatively, so it is capped to keep one misconfigured step from
 * building a list nothing downstream can hold.
 */
const MAX_COMBINATIONS = 10_000

export function mergeAllCombinations(inputs: unknown[]): unknown[] {
  const lists = inputs.map(asItems).filter((list) => list.length)
  if (!lists.length) return []
  let combos: unknown[][] = [[]]
  for (const list of lists) {
    const next: unknown[][] = []
    for (const combo of combos) {
      for (const item of list) {
        if (next.length >= MAX_COMBINATIONS) break
        next.push([...combo, item])
      }
    }
    combos = next
  }
  return combos.map((parts) =>
    parts.every(isRecord) ? Object.assign({}, ...(parts as Record<string, unknown>[])) : parts,
  )
}
