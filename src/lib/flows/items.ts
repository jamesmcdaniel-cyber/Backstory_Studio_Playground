/** A durable binary payload reference carried beside an item's JSON data. */
export type FlowBinaryData = {
  /** Opaque id in the file store. Inline bytes are intentionally not required. */
  id?: string
  data?: string
  mimeType: string
  fileName?: string
  fileSize?: number
  fileExtension?: string
}

export type FlowPairedItem = {
  /** Zero-based item index in the named input socket. */
  item: number
  input?: number
  sourceNode?: string
}

/** Universal data-plane unit. Mirrors n8n's json/binary/paired-item contract. */
export type FlowItem = {
  json: Record<string, unknown>
  binary?: Record<string, FlowBinaryData>
  pairedItem?: FlowPairedItem | FlowPairedItem[]
  error?: string
  metadata?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isFlowItem(value: unknown): value is FlowItem {
  return isRecord(value) && isRecord(value.json)
}

function jsonOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value }
}

function pairFor(index: number, parents: readonly FlowItem[], input: number, sourceNode?: string): FlowPairedItem | undefined {
  if (!parents.length) return undefined
  return { item: Math.min(index, parents.length - 1), ...(input ? { input } : {}), ...(sourceNode ? { sourceNode } : {}) }
}

/**
 * Normalize arbitrary adapter output into the universal item contract.
 * Existing items keep their binary/error/metadata fields; ordinary values gain
 * deterministic lineage back to the item that produced them.
 */
export function flowItemsFromValue(
  value: unknown,
  parents: readonly FlowItem[] = [],
  input = 0,
  sourceNode?: string,
): FlowItem[] {
  if (value === undefined) return parents.map((item) => ({ ...item }))
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry, index) => {
    if (isFlowItem(entry)) return { ...entry }
    const pairedItem = pairFor(index, parents, input, sourceNode)
    return { json: jsonOf(entry), ...(pairedItem ? { pairedItem } : {}) }
  })
}

/** Convert item packets back to the legacy value shape used by expressions. */
export function valueFromFlowItems(items: readonly FlowItem[]): unknown {
  const values = items.map((item) => item.json)
  if (values.length === 0) return undefined
  return values.length === 1 ? values[0] : values
}

/** Flatten socket inputs in socket order while preserving their input index. */
export function mergeInputItems(inputs: readonly (readonly FlowItem[])[]): FlowItem[] {
  return inputs.flatMap((items, input) =>
    items.map((item, index) => ({
      ...item,
      pairedItem: { item: index, ...(input ? { input } : {}) },
    })),
  )
}
