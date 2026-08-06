import type { ConditionOp } from '@/lib/flows/graph'

/**
 * The evaluation context threaded through a flow run: the trigger input, every
 * completed step's output keyed by node id, and (inside a loop) the current item.
 */
export type FlowContext = {
  trigger: { input: unknown }
  step: Record<string, { output: unknown }>
  // The data flowing INTO the node currently resolving its templates — what
  // `{{input}}` reads. Set per node by the interpreter's walker (per branch,
  // not a run-global), so the reference follows re-wiring: on the first step
  // it is the trigger input; mid-chain the nearest upstream DATA output
  // (branch decisions pass through); inside a per-item step, the current item.
  incoming?: unknown
  item?: unknown
  // Present inside a loop body: `{{loop.index}}` (0-based) + total count.
  loop?: { index: number; count: number }
  // The flow's typed symbol table, written by variable steps and read via
  // `{{var.<name>}}` tokens. One shared map per run (loop/parallel bodies
  // mutate the same object so writes persist past the container).
  variables?: Record<string, unknown>
  // The run's frozen clock — one `new Date()` captured at run start so every
  // `{{now}}` in a run agrees. `{{now}}` reads `iso`; `{{now.date/time/unix}}`
  // read the parts. On resume this is the resume moment (a fresh capture).
  now?: { iso: string; date: string; time: string; unix: number }
  // Run/flow metadata: `{{run.id}}`/`{{run.url}}`/`{{run.trigger}}`/
  // `{{run.startedAt}}` and the `{{flow.id}}`/`{{flow.name}}` aliases.
  run?: { id: string; url: string; resumeUrl?: string; trigger: string; startedAt: string; flowId: string; flowName: string }
  // Friendly-name fallback: normalized step LABEL → node id. The chip picker
  // stores canonical `{{step.<id>...}}` tokens, but users reading those chips
  // reasonably hand-type the plain-English labels they see (e.g.
  // `{{Previous Agent.output}}`) — those must resolve to the same step, not
  // silently blank out.
  stepAliases?: Record<string, string>
  // Node id → display LABEL, so the `{{steps}}` aggregate and the agent
  // upstream-context block can name each captured output the way the builder
  // shows it ("Fetch CRM accounts") instead of the raw node id.
  stepLabels?: Record<string, string>
}

// An HTTP node's output is the full envelope { ok, status, headers, body,
// bodyText, ... }. When aggregating for an agent, the useful payload is the
// parsed body — surface that, not the transport metadata.
function isHttpEnvelope(value: unknown): value is { body: unknown } {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    'ok' in value && 'status' in value && 'body' in value && 'bodyText' in value,
  )
}

/** The consumable payload of a step's output: an HTTP envelope collapses to its body. */
export function unwrapStepOutput(output: unknown): unknown {
  return isHttpEnvelope(output) ? output.body : output
}

/**
 * The aggregate of every captured upstream step output, keyed by the step's
 * display label (falling back to node id). This is what `{{steps}}` resolves
 * to and the source for an agent's auto-included context — so a downstream
 * agent can be fed EVERYTHING earlier nodes gathered without hand-wiring a
 * token per node. `excludeId` omits the consuming node itself.
 */
export function aggregateSteps(ctx: FlowContext, excludeId?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(ctx.step)) {
    if (id === excludeId) continue
    const label = ctx.stepLabels?.[id] || id
    // Two steps can share a label; disambiguate the collision so no data is
    // silently dropped from the aggregate.
    const key = out[label] === undefined ? label : `${label} (${id})`
    out[key] = unwrapStepOutput(entry.output)
  }
  return out
}

/** JSON, capped — used to render one step's output inside the context block. */
function cappedJson(value: unknown, max: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text == null) text = ''
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
}

/**
 * A human-readable, size-capped block of all captured upstream data, labeled by
 * step, for appending to an agent's prompt. Returns '' when there is nothing
 * upstream to include. Bounds both per-step and total size so a large API
 * response can't blow up the prompt.
 */
export function buildUpstreamContextBlock(
  ctx: FlowContext,
  excludeId: string,
  opts: { perStepMax?: number; totalMax?: number } = {},
): string {
  const perStepMax = opts.perStepMax ?? 4_000
  const totalMax = opts.totalMax ?? 12_000
  const aggregate = aggregateSteps(ctx, excludeId)
  const entries = Object.entries(aggregate)
  if (entries.length === 0) return ''
  const sections: string[] = []
  let used = 0
  let dropped = 0
  for (const [label, value] of entries) {
    if (value === undefined) continue
    const rendered = `### ${label}\n${cappedJson(value, perStepMax)}`
    if (used + rendered.length > totalMax && sections.length > 0) {
      dropped = entries.length - sections.length
      break
    }
    sections.push(rendered)
    used += rendered.length + 2
  }
  if (sections.length === 0) return ''
  const note = dropped > 0 ? `\n\n[${dropped} more earlier step${dropped === 1 ? '' : 's'} omitted for length.]` : ''
  return [
    'Data gathered by earlier steps in this flow (use it as the context for your task):',
    sections.join('\n\n'),
    'End of earlier-step data.' + note,
  ].join('\n\n')
}

/** Normalize a step label for alias lookup: trimmed, lowercased, single-spaced. */
export function normalizeStepAlias(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

// Reading a text-ish field name off a PLAIN-TEXT output means the text itself:
// an agent step's output is a string, so `step.x.output.message` (or `.text`,
// `.summary`…) resolves to the output instead of silently blanking.
const TEXT_FIELD_ALIASES = new Set(['message', 'text', 'summary', 'content', 'response', 'result', 'output', 'value', 'answer'])

/** Walk `parts` down a value; JSON-looking text is walked structured, and text-ish field names on plain text return the text. */
function walkValue(start: unknown, parts: string[]): unknown {
  let cursor: unknown = start
  for (const part of parts) {
    if (cursor == null) return undefined
    if (typeof cursor === 'string') {
      const structured = asStructured(cursor)
      if (structured !== cursor && structured !== null && typeof structured === 'object') {
        cursor = (structured as Record<string, unknown>)[part]
        continue
      }
      if (TEXT_FIELD_ALIASES.has(part)) continue
      return undefined
    }
    if (typeof cursor !== 'object') return undefined
    // `.data` on an HTTP envelope aliases `.body` (the parsed response), so
    // `{{step.<httpId>.output.data}}` reads the payload without persisting a
    // duplicate of it on the run row.
    if (part === 'data' && isHttpEnvelope(cursor) && !('data' in cursor)) {
      cursor = cursor.body
      continue
    }
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

/**
 * Resolve a leading run of `parts` as a step LABEL (longest match wins, so
 * labels containing dots still resolve) and walk the remainder from that
 * step's output. `rest` may or may not start with `output` — both
 * `Previous Agent.output.message` and `Previous Agent.message` read the same.
 */
function readStepByAlias(ctx: FlowContext, parts: string[]): { matched: boolean; value: unknown } {
  const aliases = ctx.stepAliases
  if (!aliases) return { matched: false, value: undefined }
  for (let end = parts.length; end >= 1; end--) {
    const id = aliases[normalizeStepAlias(parts.slice(0, end).join('.'))]
    if (!id) continue
    const entry = ctx.step[id]
    if (entry === undefined) return { matched: true, value: undefined } // step hasn't run yet
    const rest = parts[end] === 'output' ? parts.slice(end + 1) : parts.slice(end)
    return { matched: true, value: walkValue(entry.output, rest) }
  }
  return { matched: false, value: undefined }
}

// Roots the generic object walk understands. Anything else is either a step
// label (aliased above) or an unknown reference the caller may surface.
const KNOWN_ROOTS = new Set(['trigger', 'step', 'item', 'loop', 'variables'])

/**
 * Resolve a dot-path off the context. `found: false` means the path's ROOT is
 * not a context key, a known step id, or a step label — i.e. the reference
 * itself is broken (a typo'd or stale token), as opposed to a valid reference
 * whose value is legitimately empty.
 */
export function resolveContextPath(ctx: FlowContext, path: string): { found: boolean; value: unknown } {
  const parts = path.trim().split('.')
  // `var.<name>` roots into the variables map; deeper parts walk the value.
  if (parts[0] === 'var') {
    return { found: true, value: walkValue(ctx.variables ?? {}, parts.slice(1)) }
  }
  // `input` — the plain-English "incoming data" reference: whatever the walker
  // carried into the current node (see FlowContext.incoming). An HTTP upstream
  // collapses to its response body, same as the `{{steps}}` aggregate — the
  // chip means the payload, not the transport envelope.
  if (parts[0] === 'input') {
    return { found: true, value: walkValue(unwrapStepOutput(ctx.incoming), parts.slice(1)) }
  }
  // `now.*` reads the run's frozen clock; bare `{{now}}` is the ISO timestamp.
  // Unknown subpaths read as undefined (→ '' when templated) — never crash.
  if (parts[0] === 'now') {
    const now = ctx.now
    if (!now) return { found: true, value: undefined }
    if (parts.length === 1) return { found: true, value: now.iso }
    if (parts[1] === 'iso') return { found: true, value: now.iso }
    if (parts[1] === 'date') return { found: true, value: now.date }
    if (parts[1] === 'time') return { found: true, value: now.time }
    if (parts[1] === 'unix') return { found: true, value: now.unix }
    return { found: true, value: undefined }
  }
  // `flow.id`/`flow.name` alias the running flow's identity off the run metadata.
  if (parts[0] === 'flow') {
    const run = ctx.run
    if (!run) return { found: true, value: undefined }
    if (parts[1] === 'id') return { found: true, value: run.flowId }
    if (parts[1] === 'name') return { found: true, value: run.flowName }
    return { found: true, value: undefined }
  }
  // `run.*` reads this run's metadata (id, link, provenance, start time).
  if (parts[0] === 'run') {
    const run = ctx.run
    if (!run) return { found: true, value: undefined }
    if (parts[1] === 'id') return { found: true, value: run.id }
    if (parts[1] === 'url') return { found: true, value: run.url }
    if (parts[1] === 'resumeUrl') return { found: true, value: run.resumeUrl }
    if (parts[1] === 'trigger') return { found: true, value: run.trigger }
    if (parts[1] === 'startedAt') return { found: true, value: run.startedAt }
    return { found: true, value: undefined }
  }
  // `steps` (plural) is the AGGREGATE of every captured upstream output, keyed
  // by step label — one token feeds an agent everything gathered so far.
  // `{{steps}}` is the whole object; `{{steps.<label>}}` reads one step's data.
  if (parts[0] === 'steps') {
    const aggregate = aggregateSteps(ctx)
    if (parts.length === 1) return { found: true, value: aggregate }
    return { found: true, value: walkValue(aggregate, parts.slice(1)) }
  }
  if (KNOWN_ROOTS.has(parts[0])) {
    // `step.<key>` where <key> is not a node id: the friendly label was typed
    // where the id belongs (`{{step.Previous Agent.output}}`) — alias it.
    if (parts[0] === 'step' && parts.length > 1 && !(parts[1] in ctx.step)) {
      const aliased = readStepByAlias(ctx, parts.slice(1))
      if (aliased.matched) return { found: true, value: aliased.value }
      return { found: false, value: undefined }
    }
    return { found: true, value: walkValue(ctx, parts) }
  }
  // Unknown root — try it as a bare step label (`{{Previous Agent.output}}`).
  const aliased = readStepByAlias(ctx, parts)
  if (aliased.matched) return { found: true, value: aliased.value }
  return { found: false, value: undefined }
}

/** Read a dot-path off the context (e.g. 'trigger.input', 'step.n1.output.score', 'item'). */
export function readPath(ctx: FlowContext, path: string): unknown {
  return resolveContextPath(ctx, path).value
}

/**
 * Replace `{{path}}` tokens with values from the context. Objects -> JSON;
 * missing -> ''. `onMissing` (when given) is told about tokens whose reference
 * is BROKEN (unknown root/step — see resolveContextPath), so callers can fail
 * loudly with the exact token instead of silently posting empty text.
 */
export function resolveTemplate(template: string, ctx: FlowContext, onMissing?: (path: string) => void): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
    const res = resolveContextPath(ctx, path)
    if (!res.found) onMissing?.(path)
    if (res.value == null) return ''
    return typeof res.value === 'object' ? JSON.stringify(res.value) : String(res.value)
  })
}

/** Resolve templates inside structured values while preserving exact-token objects/arrays. */
export function resolveTemplateValue(value: unknown, ctx: FlowContext, onMissing?: (path: string) => void): unknown {
  if (typeof value === 'string') {
    const exact = value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
    if (exact) {
      const res = resolveContextPath(ctx, exact[1])
      if (!res.found) onMissing?.(exact[1])
      return res.value ?? ''
    }
    return resolveTemplate(value, ctx, onMissing)
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplateValue(item, ctx, onMissing))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplateValue(item, ctx, onMissing)]),
    )
  }
  return value
}

/** A step's text output that parses as a JSON object/array is exposed structured. */
export function asStructured(output: unknown): unknown {
  if (typeof output !== 'string') return output
  const trimmed = output.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return output
  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

/** Coerce a string to a number when it looks numeric, so comparisons order correctly. */
function coerce(value: string): number | string {
  const n = Number(value)
  return value.trim() !== '' && !Number.isNaN(n) ? n : value
}

/**
 * Trim resolved string operands before comparison. Chip insertion appends a
 * trailing space (and users hand-type padding), which would break strict
 * comparisons like eq. Non-string operands pass through untouched.
 */
function trimOperand<T>(value: T): T {
  return typeof value === 'string' ? (value.trim() as T) : value
}

const TRUTHY_TEXT = new Set(['true', 'yes', '1'])
const FALSY_TEXT = new Set(['false', 'no', '0'])

/**
 * Whether a resolved operand should count as "not there" for exists/notExists.
 * An unresolved path renders as empty or as the text of the absent value, and a
 * builder asking "does this exist" means the field, not the word.
 */
function isAbsent(value: string): boolean {
  return value === '' || value === 'undefined' || value === 'null'
}

/** Milliseconds for a date-ish operand, or null when it isn't one. */
function asTime(value: string): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** Evaluate a structured condition against the context. Never runs arbitrary code. */
/** Evaluate a single comparison. Both sides are templated (RHS may be dynamic). */
export function evalClause(
  clause: { left: string; op: ConditionOp; right: string; ignoreCase?: boolean },
  ctx: FlowContext,
): boolean {
  const leftResolved = trimOperand(resolveTemplate(clause.left, ctx))
  const rightResolved = trimOperand(resolveTemplate(clause.right, ctx))
  // Case-insensitive matching is a per-clause toggle (n8n parity). It folds the
  // operands for the text operators only — numeric and date comparisons below
  // are unaffected by case, and folding them would be a no-op anyway.
  const fold = (value: string) => (clause.ignoreCase ? value.toLowerCase() : value)
  const leftRaw = fold(leftResolved)
  const rightRaw = fold(rightResolved)
  const cond = clause
  switch (cond.op) {
    case 'contains':
      return leftRaw.includes(rightRaw)
    case 'notContains':
      return !leftRaw.includes(rightRaw)
    case 'startsWith':
      return leftRaw.startsWith(rightRaw)
    case 'endsWith':
      return leftRaw.endsWith(rightRaw)
    case 'matches':
      try {
        return new RegExp(rightRaw, clause.ignoreCase ? 'i' : undefined).test(leftResolved)
      } catch {
        return false
      }
    // Unary operators ignore the right-hand side entirely. "Empty" means no
    // characters after trimming; "exists" additionally treats the literal
    // strings an unresolved value renders as ("undefined"/"null") as absent, so
    // a missing field reads as missing rather than as the text of its absence.
    case 'isEmpty':
      return leftResolved === ''
    case 'isNotEmpty':
      return leftResolved !== ''
    case 'exists':
      return !isAbsent(leftResolved)
    case 'notExists':
      return isAbsent(leftResolved)
    case 'isTrue':
      return TRUTHY_TEXT.has(leftRaw.toLowerCase())
    case 'isFalse':
      return FALSY_TEXT.has(leftRaw.toLowerCase())
    // Date comparison falls back to string/number ordering when either side
    // isn't a parseable date, so a version string or a timestamp still orders
    // sensibly instead of silently returning false.
    case 'before':
    case 'after': {
      const l = asTime(leftResolved)
      const r = asTime(rightResolved)
      if (l === null || r === null) return cond.op === 'before' ? leftRaw < rightRaw : leftRaw > rightRaw
      return cond.op === 'before' ? l < r : l > r
    }
    default: {
      const l = coerce(leftRaw)
      const r = coerce(rightRaw)
      switch (cond.op) {
        case 'eq':
          return l === r
        case 'neq':
          return l !== r
        case 'gt':
          return l > r
        case 'gte':
          return l >= r
        case 'lt':
          return l < r
        case 'lte':
          return l <= r
      }
    }
  }
  return false
}

/**
 * Evaluate a condition node's data. Multi-criteria: `clauses` combined with
 * `match` (all=AND / any=OR). Falls back to the legacy single left/op/right.
 */
export function evalCondition(
  data: {
    match?: 'all' | 'any'
    clauses?: { left: string; op: ConditionOp; right: string }[]
    left?: string
    op?: ConditionOp
    right?: string
  },
  ctx: FlowContext,
): boolean {
  const clauses =
    data.clauses && data.clauses.length
      ? data.clauses
      : data.left !== undefined && data.op && data.right !== undefined
        ? [{ left: data.left, op: data.op, right: data.right }]
        : []
  if (!clauses.length) return false
  return (data.match ?? 'all') === 'any' ? clauses.some((c) => evalClause(c, ctx)) : clauses.every((c) => evalClause(c, ctx))
}
