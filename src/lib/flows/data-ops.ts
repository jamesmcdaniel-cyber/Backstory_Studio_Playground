import type { ConditionClause, DataOp } from '@/lib/flows/graph'
import { asStructured, evalClause, readPath, resolveTemplate, type FlowContext } from '@/features/flows/context'
import { isFileReference } from '@/lib/flows/file-ref'

/** Ops that read a value as TEXT — for these, a file reference resolves to its
 *  extracted content so "download a file → parse it" works with no extra step. */
const TEXT_INPUT_OPS = new Set<DataOp>(['parseJson', 'parseCsv', 'split', 'replace'])

/**
 * Pure data-operation transforms for the `data` node family (MS Data Operation
 * parity): compose, parseJson, join, csvTable, htmlTable, filterArray, select.
 *
 * The interpreter resolves the step's `input` template BEFORE calling
 * `runDataOp` — this module never touches the interpreter. It does reuse the
 * pure evaluation helpers from context.ts (evalClause/readPath/resolveTemplate)
 * so filterArray clauses and select values resolve `{{item.*}}` tokens exactly
 * the way the existing filter node and loop bodies do.
 */

export type DataOpConfig = {
  /** The already-resolved input value (exact tokens keep their structure). */
  input?: unknown
  /** join: the separator between items (default ','). */
  separator?: string
  /** parseJson: JSON Schema text — stored for the editor, not enforced in v1. */
  schema?: string
  /** filterArray: every clause must pass for an item to be kept (AND). */
  clauses?: ConditionClause[]
  /** select: per-item output fields; `value` supports `{{item.*}}` tokens. */
  fields?: { name: string; value: string }[]
  /**
   * Optional outer flow context: when provided, filterArray/select clauses and
   * values can also reference trigger/step/var data alongside `{{item.*}}`.
   */
  ctx?: FlowContext
  /** replace: the text to find and its replacement (default ''). */
  find?: string
  replaceWith?: string
  /** getItem: 0-based position; negatives count from the end. Default 0. */
  index?: string
  /** trim: items to remove (default 1) and which end to remove from. */
  count?: string
  fromEnd?: boolean
}

export type DataOpResult = { output: unknown } | { error: string }

/** Display names matching the step picker copy — used in error messages. */
export const DATA_OP_LABELS: Record<DataOp, string> = {
  compose: 'Compose',
  parseJson: 'Parse JSON',
  join: 'Join',
  csvTable: 'Create CSV table',
  htmlTable: 'Create HTML table',
  filterArray: 'Filter array',
  select: 'Select',
  split: 'Split text',
  replace: 'Find & replace',
  getItem: 'Get item',
  flatten: 'Flatten list',
  trim: 'Trim list',
  parseCsv: 'Parse CSV',
}

/** RFC 4180 CSV: quoted fields may hold commas, newlines, and doubled quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/\r\n/g, '\n')
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

/** Coerce input to a list: structured arrays as-is; anything else is not a list. */
const asList = (input: unknown): unknown[] | null => {
  const structured = asStructured(input)
  return Array.isArray(structured) ? structured : null
}

const itemText = (item: unknown): string => {
  if (item === undefined || item === null) return ''
  return typeof item === 'object' ? JSON.stringify(item) : String(item)
}

/** A minimal per-item context so `{{item.*}}` resolves; outer ctx data rides along. */
const itemContext = (item: unknown, ctx?: FlowContext): FlowContext => ({
  trigger: ctx?.trigger ?? { input: undefined },
  step: ctx?.step ?? {},
  ...(ctx?.variables ? { variables: ctx.variables } : {}),
  // Keep the enclosing loop's counters reachable — a data op inside a loop
  // body may reference {{loop.index}} even though {{item}} is shadowed by
  // the array item being filtered/mapped.
  ...(ctx?.loop ? { loop: ctx.loop } : {}),
  item,
})

// ── CSV / HTML rendering (XSS + injection safety is load-bearing here) ──────

/** Quote a CSV field when it contains a comma, quote, or line break; double quotes. */
const csvEscape = (text: string): string => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)

/** Escape every HTML-significant character — cells and headers are untrusted. */
const htmlEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Normalize list items to records and collect the union of column names in first-seen order. */
const tableRows = (items: unknown[]): { headers: string[]; rows: Record<string, unknown>[] } => {
  const rows = items.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item },
  )
  const headers: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key)
    }
  }
  return { headers, rows }
}

const cellText = (row: Record<string, unknown>, header: string): string => itemText(row[header])

// ── The op runner ────────────────────────────────────────────────────────────

/** Run one pure data operation over an already-resolved config. */
export function runDataOp(op: DataOp, config: DataOpConfig): DataOpResult {
  const label = DATA_OP_LABELS[op]
  // A file reference fed to a text-reading op unwraps to its extracted content,
  // so a downloaded/uploaded file parses without a separate "read file" step.
  if (TEXT_INPUT_OPS.has(op) && isFileReference(config.input) && typeof config.input.content === 'string') {
    config = { ...config, input: config.input.content }
  }
  if (isBlank(config.input)) return { error: `${label} needs data to work with — the input came back empty.` }

  if (op === 'compose') {
    // Passthrough: a JSON-looking string is exposed structured, like step outputs.
    return { output: asStructured(config.input) }
  }

  if (op === 'parseJson') {
    // Already-structured input (an exact token resolved to an object/array)
    // has nothing left to parse. `schema` is stored but not enforced in v1.
    if (typeof config.input !== 'string') return { output: config.input }
    try {
      return { output: JSON.parse(config.input.trim()) }
    } catch {
      return { error: `${label} needs valid JSON — the content couldn't be parsed.` }
    }
  }

  if (op === 'join') {
    // Decision: a non-array input joins as a single-item list (its text) rather
    // than failing — MS Join degrades the same way for scalar payloads.
    const list = asList(config.input) ?? [config.input]
    return { output: list.map(itemText).join(config.separator ?? ',') }
  }

  if (op === 'csvTable' || op === 'htmlTable') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list of records — the input wasn't a list.` }
    const { headers, rows } = tableRows(list)
    if (op === 'csvTable') {
      const lines = [headers.map(csvEscape).join(',')]
      for (const row of rows) lines.push(headers.map((header) => csvEscape(cellText(row, header))).join(','))
      return { output: lines.join('\n') }
    }
    const head = headers.map((header) => `<th>${htmlEscape(header)}</th>`).join('')
    const body = rows
      .map((row) => `<tr>${headers.map((header) => `<td>${htmlEscape(cellText(row, header))}</td>`).join('')}</tr>`)
      .join('')
    return { output: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` }
  }

  if (op === 'filterArray') {
    const clauses = config.clauses ?? []
    if (!clauses.length) return { error: `${label} needs at least one condition.` }
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to filter — the input wasn't a list.` }
    const output = list.filter((item) => {
      const ctx = itemContext(item, config.ctx)
      return clauses.every((clause) => evalClause(clause, ctx))
    })
    return { output }
  }

  if (op === 'parseCsv') {
    // CSV text -> list of records keyed by the header row. Quoted fields
    // (embedded commas/newlines/doubled quotes) parse per RFC 4180 — this
    // reads back exactly what the csvTable op writes.
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    const rows = parseCsvRows(text)
    if (!rows.length || !rows[0].some((cell) => cell.trim() !== '')) {
      return { error: `${label} needs CSV text with a header row.` }
    }
    const [headers, ...body] = rows
    const output = body
      .filter((row) => row.some((cell) => cell.trim() !== ''))
      .map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ''])))
    return { output }
  }

  if (op === 'split') {
    // Text → list. Structured input is stringified first (itemText), so a
    // list accidentally wired here degrades predictably instead of failing.
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    const separator = config.separator ?? ','
    return { output: text.split(separator).map((piece) => piece.trim()).filter((piece) => piece !== '') }
  }

  if (op === 'replace') {
    if (!config.find) return { error: `${label} needs the text to find.` }
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    return { output: text.split(config.find).join(config.replaceWith ?? '') }
  }

  if (op === 'getItem') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to take an item from — the input wasn't a list.` }
    const raw = (config.index ?? '').trim()
    const index = raw === '' ? 0 : Number(raw)
    if (!Number.isInteger(index)) return { error: `${label} needs a whole-number position — got "${raw}".` }
    const resolved = index < 0 ? list.length + index : index
    if (resolved < 0 || resolved >= list.length) {
      return { error: `${label} asked for item ${index} but the list has ${list.length} item${list.length === 1 ? '' : 's'}.` }
    }
    return { output: list[resolved] }
  }

  if (op === 'flatten') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to flatten — the input wasn't a list.` }
    return { output: list.flat(Infinity) }
  }

  if (op === 'trim') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to trim — the input wasn't a list.` }
    const raw = (config.count ?? '').trim()
    const count = raw === '' ? 1 : Number(raw)
    if (!Number.isInteger(count) || count < 0) return { error: `${label} needs a whole number of items to remove — got "${raw}".` }
    return { output: config.fromEnd ? list.slice(0, Math.max(0, list.length - count)) : list.slice(count) }
  }

  // select
  const fields = (config.fields ?? []).filter((field) => field.name.trim())
  if (!fields.length) return { error: `${label} needs at least one field to map.` }
  const list = asList(config.input)
  if (!list) return { error: `${label} needs a list to map — the input wasn't a list.` }
  const output = list.map((item) => {
    const ctx = itemContext(item, config.ctx)
    const record: Record<string, unknown> = {}
    for (const field of fields) {
      const exact = field.value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
      // An exact token keeps the source value's structure; a missing source
      // field maps to null (never a crash). Mixed text resolves as a string.
      record[field.name.trim()] = exact ? readPath(ctx, exact[1]) ?? null : resolveTemplate(field.value, ctx)
    }
    return record
  })
  return { output }
}
