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
 * Which records survive a key join — n8n's "Output Type".
 *
 * We had two of these five, expressed as a boolean: `includeUnpaired` true was
 * keepEverything and false was keepMatches. That cannot say "the accounts that
 * had NO match" (an anti-join, for finding what is missing) or "every account,
 * enriched where CRM data existed" (a left join, the single most common merge
 * in a sales flow). Both were unreachable.
 */
export type MergeJoinMode =
  /** Only key values present in every input. */
  | 'keepMatches'
  /** Only key values present in exactly one input — what did NOT match. */
  | 'keepNonMatches'
  /** Everything, matched or not. */
  | 'keepEverything'
  /** Every record of the first input, enriched where a later one matched. */
  | 'enrichInput1'
  /** Every record of the second input, enriched where another matched. */
  | 'enrichInput2'

/**
 * Which side wins when both carry the same field — n8n's "Clash Handling".
 *
 * It was always preferLast, silently: merging a CRM record into an account
 * overwrote the account's own `name` with the CRM's, and nothing said so.
 */
export type MergeClash = 'preferLast' | 'preferFirst' | 'deepMerge'

function deepMergeRecords(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const existing = out[key]
    out[key] = isRecord(existing) && isRecord(value) ? deepMergeRecords(existing, value) : value
  }
  return out
}

function combine(existing: Record<string, unknown>, item: Record<string, unknown>, clash: MergeClash): Record<string, unknown> {
  if (clash === 'preferFirst') return { ...item, ...existing }
  if (clash === 'deepMerge') return deepMergeRecords(existing, item)
  return { ...existing, ...item }
}

export type MergeByKeyOptions = {
  /**
   * The matching field on inputs AFTER the first, when it is named differently
   * — `email` on one side, `emailAddress` on the other. Requiring one name for
   * both sides meant those two lists simply could not be joined.
   */
  keyRight?: string
  joinMode?: MergeJoinMode
  clash?: MergeClash
}

/**
 * combineByKey: join record lists on a key field.
 *
 * Records that share a key value are combined into one; records missing the key
 * stand alone. First-seen key order is preserved.
 */
export function mergeByKey(
  inputs: unknown[],
  key: string | undefined,
  includeUnpaired = true,
  options: MergeByKeyOptions = {},
): unknown[] {
  const field = (key ?? '').trim()
  if (!field) return mergeAppend(inputs)
  const rightField = options.keyRight?.trim() || field
  const clash = options.clash ?? 'preferLast'
  // Back-compat: the boolean is what every saved flow carries, and it maps onto
  // exactly the two modes it could express.
  const joinMode: MergeJoinMode = options.joinMode ?? (includeUnpaired ? 'keepEverything' : 'keepMatches')

  const order: string[] = []
  const byKey = new Map<string, Record<string, unknown>>()
  /** Which input indexes each key value appeared in. */
  const inputsForKey = new Map<string, Set<number>>()
  const loose: unknown[] = []

  inputs.forEach((input, index) => {
    const keyField = index === 0 ? field : rightField
    for (const item of asItems(input)) {
      if (!isRecord(item) || item[keyField] === undefined || item[keyField] === null) {
        loose.push(item)
        continue
      }
      const id = String(item[keyField])
      const seen = inputsForKey.get(id)
      if (seen) seen.add(index)
      else inputsForKey.set(id, new Set([index]))

      const existing = byKey.get(id)
      if (existing) {
        byKey.set(id, combine(existing, item, clash))
      } else {
        byKey.set(id, { ...item })
        order.push(id)
      }
    }
  })

  const total = inputs.length
  const keep = (id: string): boolean => {
    const seen = inputsForKey.get(id) ?? new Set<number>()
    switch (joinMode) {
      case 'keepMatches':
        // Present in EVERY input. The old code asked for "more than one", which
        // is the same thing for two inputs and quietly wrong for three.
        return seen.size === total
      case 'keepNonMatches':
        return seen.size === 1
      case 'enrichInput1':
        return seen.has(0)
      case 'enrichInput2':
        return seen.has(1)
      case 'keepEverything':
      default:
        return true
    }
  }

  const joined = order.filter(keep).map((id) => byKey.get(id)!)
  // Keyless records have no partner by construction, so they travel only with
  // the modes that keep unmatched rows at all.
  const keepsLoose = joinMode === 'keepEverything' || joinMode === 'keepNonMatches'
  return keepsLoose ? [...joined, ...loose] : joined
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
