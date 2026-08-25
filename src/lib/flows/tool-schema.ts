import { humanizeToolName } from '@/lib/flows/humanize-tool-name'

/**
 * Read a tool's JSON-Schema into typed, renderable fields.
 *
 * The builder used to read `properties[name].type` and nothing else, which
 * assumed every schema is one level deep and spells its type out inline. Real
 * MCP schemas do not: an optional argument is `anyOf: [{type: 'string'},
 * {type: 'null'}]`, a shared shape is a `$ref` into `$defs`, a bounded number
 * carries `minimum`/`maximum`, a date carries `format`. Each of those fell
 * through `prop.type ?? 'string'` and became an unconstrained text box — the
 * schema said "one of these four values, or a date, or a number from 1 to 100"
 * and the form said "type something".
 *
 * Everything here is display-and-validation metadata. The stored args JSON is
 * still keyed by the raw property name, so nothing about the wire format
 * changes.
 */

export type ToolFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'multiEnum'
  | 'dateTime'
  | 'object'
  | 'array'
  | 'any'

export type ToolFieldOption = { value: string; label: string }

export type ToolField = {
  /** The wire key. Stays exactly as the schema spells it. */
  name: string
  /** What the form shows: the schema's own title, else the key made readable. */
  label: string
  type: ToolFieldType
  required: boolean
  description?: string
  options?: ToolFieldOption[]
  /** Prefilled when the argument is absent, so the form agrees with the tool. */
  default?: unknown
  min?: number
  max?: number
  /** True when the schema explicitly permits null (an `anyOf` with a null arm). */
  nullable?: boolean
}

type SchemaNode = {
  type?: string | string[]
  title?: string
  description?: string
  enum?: unknown[]
  const?: unknown
  default?: unknown
  format?: string
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  items?: SchemaNode
  properties?: Record<string, SchemaNode>
  required?: string[]
  anyOf?: SchemaNode[]
  oneOf?: SchemaNode[]
  allOf?: SchemaNode[]
  $ref?: string
  $defs?: Record<string, SchemaNode>
  definitions?: Record<string, SchemaNode>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** Follow a local `$ref` (`#/$defs/Name`). Foreign refs are left unresolved. */
function deref(node: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode {
  const ref = node.$ref
  if (!ref || !ref.startsWith('#/') || seen.has(ref)) return node
  seen.add(ref)
  const path = ref.slice(2).split('/')
  let current: unknown = root
  for (const segment of path) {
    if (!isRecord(current)) return node
    // JSON Pointer escapes, so a key containing '/' or '~' still resolves.
    current = current[segment.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  if (!isRecord(current)) return node
  // A ref alongside siblings keeps the siblings (title/description overrides).
  return { ...(current as SchemaNode), ...node, $ref: undefined }
}

/**
 * Collapse the wrapper keywords into one effective node.
 *
 * `anyOf: [{type: 'string'}, {type: 'null'}]` is how a schema generator spells
 * "optional string" — the null arm is noise for a form, so it is recorded as
 * `nullable` and the real arm is used. An `anyOf` of consts is an enum written
 * the long way, and is read as one.
 */
function effective(node: SchemaNode, root: SchemaNode, seen: Set<string>): { node: SchemaNode; nullable: boolean } {
  let current = deref(node, root, seen)
  let nullable = false

  // `type: ['string', 'null']` — the same idea in the other spelling.
  if (Array.isArray(current.type)) {
    const named = current.type.filter((entry) => entry !== 'null')
    nullable = named.length !== current.type.length
    current = { ...current, type: named[0] }
  }

  const branches = current.anyOf ?? current.oneOf
  if (branches?.length) {
    const resolved = branches.map((branch) => deref(branch, root, seen))
    const real = resolved.filter((branch) => branch.type !== 'null' && branch.const !== null)
    nullable = nullable || real.length !== resolved.length

    // Every arm a const → an enumeration spelled as a union.
    const consts = real.map((branch) => branch.const).filter((value) => value !== undefined)
    if (consts.length && consts.length === real.length) {
      current = { ...current, enum: consts, type: typeof consts[0] === 'number' ? 'number' : 'string', anyOf: undefined, oneOf: undefined }
    } else if (real.length) {
      // Merge the chosen arm under the parent's own title/description.
      const [first, ...rest] = real
      const merged = { ...first, ...current, anyOf: undefined, oneOf: undefined }
      merged.type = current.type ?? first.type
      merged.enum = current.enum ?? first.enum
      merged.format = current.format ?? first.format
      merged.items = current.items ?? first.items
      // A union of several real shapes cannot be one control; treat it as free.
      current = rest.length ? { ...merged, type: merged.type ?? undefined } : merged
    }
  }

  if (current.allOf?.length) {
    // allOf is an intersection; fold the members under the parent.
    let folded: SchemaNode = { ...current, allOf: undefined }
    for (const member of current.allOf) {
      const resolved = deref(member, root, seen)
      folded = {
        ...resolved,
        ...folded,
        properties: { ...(resolved.properties ?? {}), ...(folded.properties ?? {}) },
        required: [...(resolved.required ?? []), ...(folded.required ?? [])],
      }
    }
    current = folded
  }

  return { node: current, nullable }
}

function optionsOf(values: unknown[]): ToolFieldOption[] {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => {
      const raw = String(value)
      // Enum members are API constants (`in_progress`, `CLOSED_WON`); show them
      // the way the rest of the builder shows raw identifiers.
      return { value: raw, label: /^[a-z0-9]+([_-][a-z0-9]+)+$/i.test(raw) ? humanizeToolName(raw) : raw }
    })
}

function classify(node: SchemaNode): ToolFieldType {
  if (node.enum?.length) return 'enum'
  const type = typeof node.type === 'string' ? node.type : undefined
  if (type === 'array') {
    return node.items?.enum?.length ? 'multiEnum' : 'array'
  }
  if (type === 'object') return 'object'
  if (type === 'boolean') return 'boolean'
  if (type === 'number' || type === 'integer') return 'number'
  if (type === 'string') return node.format === 'date-time' || node.format === 'date' ? 'dateTime' : 'string'
  // No usable type: a free value rather than a silent "string".
  return 'any'
}

/** Sentence-case a raw property key: `peopleai_object_id` → "Peopleai object id". */
function labelFor(name: string, node: SchemaNode): string {
  return node.title?.trim() || humanizeToolName(name)
}

/**
 * The renderable fields of a tool's input schema, required ones first.
 *
 * Ordering matters more than it looks: `Object.entries` order is whatever the
 * server serialized, so a tool whose one essential argument happens to be
 * declared third put two optional boxes above it.
 */
export function toolFields(inputSchema: unknown): ToolField[] {
  if (!isRecord(inputSchema)) return []
  const root = inputSchema as SchemaNode
  const { node: schema } = effective(root, root, new Set())
  if (!schema.properties || !isRecord(schema.properties)) return []

  const requiredNames = new Set(schema.required ?? [])
  const fields: ToolField[] = []

  for (const [name, rawProp] of Object.entries(schema.properties)) {
    if (!isRecord(rawProp)) continue
    const { node, nullable } = effective(rawProp as SchemaNode, root, new Set())
    const type = classify(node)
    const enumValues = type === 'multiEnum' ? node.items?.enum : node.enum
    const min = node.minimum ?? (node.exclusiveMinimum !== undefined ? node.exclusiveMinimum + 1 : undefined)
    const max = node.maximum ?? (node.exclusiveMaximum !== undefined ? node.exclusiveMaximum - 1 : undefined)

    fields.push({
      name,
      label: labelFor(name, node),
      type,
      required: requiredNames.has(name),
      ...(node.description ? { description: node.description } : {}),
      ...(enumValues?.length ? { options: optionsOf(enumValues) } : {}),
      ...(node.default !== undefined ? { default: node.default } : {}),
      ...(type === 'number' && min !== undefined ? { min } : {}),
      ...(type === 'number' && max !== undefined ? { max } : {}),
      ...(nullable ? { nullable: true } : {}),
    })
  }

  // Required first, each group keeping its declared order. A stable partition,
  // not a sort, so two required fields never swap between renders.
  return [...fields.filter((field) => field.required), ...fields.filter((field) => !field.required)]
}

/** The defaults a schema declares, for prefilling an argument set. */
export function toolFieldDefaults(fields: ToolField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) if (field.default !== undefined) out[field.name] = field.default
  return out
}
