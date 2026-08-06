import type { ConditionClause, DataOp } from '@/lib/flows/graph'
import { asStructured, evalClause, readPath, resolveTemplate, type FlowContext } from '@/features/flows/context'
import { isFileReference } from '@/lib/flows/file-ref'

/** Ops that read a value as TEXT — for these, a file reference resolves to its
 *  extracted content so "download a file → parse it" works with no extra step. */
const TEXT_INPUT_OPS = new Set<DataOp>(['parseJson', 'parseCsv', 'split', 'replace', 'markdownToHtml', 'htmlToMarkdown', 'xmlParse'])

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
  /** filterArray: combine clauses with 'all' (AND, default) or 'any' (OR). */
  match?: 'all' | 'any'
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
  /** trim: items to remove (default 1); limit: items to keep (default 10). */
  count?: string
  fromEnd?: boolean
  /** sort/removeDuplicates: the field to key on; summarize: the group-by field. */
  by?: string
  /** sort: descending instead of ascending. */
  descending?: boolean
  /** summarize: what to compute per group. */
  aggregations?: { field: string; op: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'countUnique' | 'concat' | 'append'; name?: string }[]
  /** formatDate: the output pattern (YYYY, MM, DD, HH, mm, ss). */
  format?: string
  /** dateShift / dateDiff: the time unit. */
  unit?: string
  /** dateShift: how much to add — negative subtracts. Already resolved. */
  amount?: string
  /** datePart: which part to pick. */
  part?: string
  /** dateDiff: the end date (input is the start). Already resolved. */
  to?: string
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
  sort: 'Sort',
  limit: 'Limit',
  removeDuplicates: 'Remove duplicates',
  aggregate: 'Aggregate',
  summarize: 'Summarize',
  formatDate: 'Format a date',
  dateShift: 'Add or subtract time',
  dateDiff: 'Time between dates',
  datePart: 'Pick a date part',
  renameKeys: 'Rename fields',
  markdownToHtml: 'Markdown to HTML',
  htmlToMarkdown: 'HTML to Markdown',
  xmlParse: 'Parse XML',
  xmlBuild: 'Create XML',
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
    // Two modes, matching n8n's Set/Edit Fields:
    //   • fields declared → build an object from them (the "hold these values
    //     for later" step: a token, a bearer, a reshaped record).
    //   • no fields → passthrough, exposing a JSON-looking string structured,
    //     which is what Compose did before object mode existed.
    const composed = (config.fields ?? []).filter((field) => field.name.trim())
    if (!composed.length) return { output: asStructured(config.input) }
    const ctx = itemContext(config.input, config.ctx)
    const record: Record<string, unknown> = {}
    for (const field of composed) {
      const exact = field.value.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
      // An exact token keeps the source value's structure (an object stays an
      // object); mixed text resolves to a string. Same rule as `select`.
      // Dotted names build nested objects (n8n Set parity).
      assignField(record, field.name.trim(), exact ? readPath(ctx, exact[1]) ?? null : resolveTemplate(field.value, ctx))
    }
    return { output: record }
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
    // n8n Filter parity: conditions combine with AND (default) or OR.
    const output = list.filter((item) => {
      const ctx = itemContext(item, config.ctx)
      return config.match === 'any' ? clauses.some((clause) => evalClause(clause, ctx)) : clauses.every((clause) => evalClause(clause, ctx))
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
    const field = (config.by ?? '').trim()
    if (!field) return { output: list.flat(Infinity) }
    // n8n Split Out parity: each element of `field`'s list becomes its own
    // item, carrying the record's other TOP-LEVEL fields alongside it. A
    // nested path (a.b) splits out the elements themselves — there is no
    // sensible single home for the parent fields in that shape.
    const output: unknown[] = []
    for (const item of list) {
      const value = readPath(itemContext(item, config.ctx), `item.${field}`)
      const elements = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
      const nested = field.includes('.')
      const parent = !nested && item && typeof item === 'object' && !Array.isArray(item) ? { ...(item as Record<string, unknown>) } : null
      if (parent) delete parent[field]
      for (const element of elements) output.push(parent ? { ...parent, [field]: element } : element)
    }
    return { output }
  }

  if (op === 'trim') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to trim — the input wasn't a list.` }
    const raw = (config.count ?? '').trim()
    const count = raw === '' ? 1 : Number(raw)
    if (!Number.isInteger(count) || count < 0) return { error: `${label} needs a whole number of items to remove — got "${raw}".` }
    return { output: config.fromEnd ? list.slice(0, Math.max(0, list.length - count)) : list.slice(count) }
  }

  // ---- Item-shaping ops (n8n ships each of these as its own core node) ----

  if (op === 'sort' || op === 'limit' || op === 'removeDuplicates' || op === 'aggregate' || op === 'summarize') {
    const list = asList(config.input)
    if (!list) return { error: `${label} needs a list to work on — the input wasn't a list.` }
    // n8n parity: each of these accepts SEVERAL fields, comma-separated.
    const keys = (config.by ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
    const valueOf = (item: unknown, field: string) => readPath(itemContext(item, config.ctx), `item.${field}`)

    if (op === 'sort') {
      // Stable by construction: decorate with the original index and fall back
      // to it, so equal keys keep input order across engines. Several fields
      // compare in order, like n8n's multi-field sort.
      const decorated = list.map((item, index) => ({ item, index, keys: keys.length ? keys.map((field) => valueOf(item, field)) : [item] }))
      decorated.sort((a, b) => {
        for (let k = 0; k < a.keys.length; k++) {
          const order = compareValues(a.keys[k], b.keys[k])
          if (order !== 0) return order
        }
        return a.index - b.index
      })
      if (config.descending) decorated.reverse()
      return { output: decorated.map((entry) => entry.item) }
    }

    if (op === 'limit') {
      const raw = (config.count ?? '10').trim()
      const count = Number(raw)
      if (!Number.isInteger(count) || count < 0) return { error: `${label} needs a whole number of items to keep — got "${raw}".` }
      return { output: config.fromEnd ? list.slice(Math.max(0, list.length - count)) : list.slice(0, count) }
    }

    if (op === 'removeDuplicates') {
      const seen = new Set<string>()
      const output = list.filter((item) => {
        // Key on the given field(s), else on the whole item's JSON — so
        // structurally identical records collapse without naming a field.
        const identity = JSON.stringify(keys.length ? keys.map((field) => valueOf(item, field) ?? null) : item ?? null)
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
      })
      return { output }
    }

    if (op === 'aggregate') {
      // Collapse the list into ONE value: a single field gives its values as a
      // list (back-compat); several fields give { field: [values] } per field
      // (n8n's aggregate-individual-fields); none gives the list as one item.
      if (!keys.length) return { output: list }
      if (keys.length === 1) return { output: list.map((item) => valueOf(item, keys[0])) }
      return { output: Object.fromEntries(keys.map((field) => [field, list.map((item) => valueOf(item, field))])) }
    }

    // summarize — group by the given field(s) (or the whole list as one group)
    // and compute the requested aggregations per group.
    const aggregations = (config.aggregations ?? []).filter((entry) => entry.op)
    if (!aggregations.length) return { error: `${label} needs at least one thing to calculate.` }
    const groups = new Map<string, unknown[]>()
    for (const item of list) {
      const groupKey = keys.length ? JSON.stringify(keys.map((field) => valueOf(item, field) ?? '')) : ''
      const bucket = groups.get(groupKey)
      if (bucket) bucket.push(item)
      else groups.set(groupKey, [item])
    }
    const output = [...groups.entries()].map(([groupKey, items]) => {
      const row: Record<string, unknown> = {}
      if (keys.length) {
        const values = JSON.parse(groupKey) as unknown[]
        keys.forEach((field, index) => { row[field] = values[index] })
      }
      for (const entry of aggregations) {
        const name = (entry.name ?? `${entry.op}_${entry.field || 'items'}`).trim()
        row[name] = summarizeValues(entry.op, items, entry.field, config.ctx)
      }
      return row
    })
    return { output }
  }

  // ---- Date & Time (n8n's dedicated node) — all math and formatting in UTC,
  // so a flow computes the same date on every machine and every re-run. ----

  if (op === 'formatDate' || op === 'dateShift' || op === 'dateDiff' || op === 'datePart') {
    const date = parseDateInput(config.input)
    if (!date) return { error: `${label} needs a date to work with — "${itemText(config.input)}" couldn't be read as one.` }

    if (op === 'formatDate') {
      return { output: formatUtcDate(date, (config.format ?? '').trim() || 'YYYY-MM-DD') }
    }

    if (op === 'dateShift') {
      const raw = (config.amount ?? '').trim()
      const amount = Number(raw)
      if (raw === '' || !Number.isFinite(amount)) {
        return { error: `${label} needs the amount to add — a number; negative subtracts.` }
      }
      const unit = normalizeDateUnit(config.unit)
      if (!unit) return { error: `${label} needs a time unit — seconds, minutes, hours, days, weeks, months, or years.` }
      return { output: shiftUtcDate(date, amount, unit).toISOString() }
    }

    if (op === 'dateDiff') {
      const end = parseDateInput(config.to)
      if (!end) return { error: `${label} needs the end date — "${itemText(config.to)}" couldn't be read as one.` }
      const unit = normalizeDateUnit(config.unit) ?? 'days'
      return { output: dateDifference(date, end, unit) }
    }

    // datePart
    const part = (config.part ?? '').trim() || 'date'
    const value = datePartValue(date, part)
    if (value === undefined) {
      return { error: `${label} doesn't know the part "${part}" — pick year, month, day, hour, minute, second, weekday, date, or time.` }
    }
    return { output: value }
  }

  if (op === 'renameKeys') {
    const pairs = (config.fields ?? []).filter((field) => field.name.trim() && field.value.trim())
    if (!pairs.length) return { error: `${label} needs at least one rename — the current field name and its new name.` }
    const rename = (item: unknown): unknown => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const source = item as Record<string, unknown>
      const byOld = new Map(pairs.map((pair) => [pair.name.trim(), pair.value.trim()]))
      return Object.fromEntries(Object.entries(source).map(([key, value]) => [byOld.get(key) ?? key, value]))
    }
    const structured = asStructured(config.input)
    return { output: Array.isArray(structured) ? structured.map(rename) : rename(structured) }
  }

  if (op === 'markdownToHtml') {
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    return { output: markdownToHtml(text) }
  }

  if (op === 'htmlToMarkdown') {
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    return { output: htmlToMarkdown(text) }
  }

  if (op === 'xmlParse') {
    const text = typeof config.input === 'string' ? config.input : itemText(config.input)
    try {
      return { output: parseXml(text) }
    } catch (error) {
      return { error: `${label} needs well-formed XML — ${error instanceof Error ? error.message : 'the content could not be parsed'}.` }
    }
  }

  if (op === 'xmlBuild') {
    const structured = asStructured(config.input)
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return { error: `${label} needs an object to turn into XML — field names become the tags.` }
    }
    return { output: buildXmlDocument(structured as Record<string, unknown>) }
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
      // Dotted names build nested objects (n8n Set parity).
      assignField(record, field.name.trim(), exact ? readPath(ctx, exact[1]) ?? null : resolveTemplate(field.value, ctx))
    }
    return record
  })
  return { output }
}

/** Order two resolved values: numbers numerically, everything else as text. */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const an = Number(a)
  const bn = Number(b)
  if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') return an - bn
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/** One aggregation over a group's items. */
function summarizeValues(
  op: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'countUnique' | 'concat' | 'append',
  items: unknown[],
  field: string,
  ctx: FlowContext | undefined,
): unknown {
  if (op === 'count') return items.length
  const rawValues = items.map((item) => (field ? readPath(itemContext(item, ctx), `item.${field}`) : item))
  // n8n Summarize parity: countUnique / concatenate / append work on the raw
  // values; the numeric ops coerce and skip what isn't a number.
  if (op === 'countUnique') return new Set(rawValues.map((value) => JSON.stringify(value ?? null))).size
  if (op === 'concat') return rawValues.filter((value) => value !== undefined && value !== null).map(itemText).join(', ')
  if (op === 'append') return rawValues.filter((value) => value !== undefined)
  const numbers = rawValues.map(Number).filter((value) => !Number.isNaN(value))
  if (!numbers.length) return 0
  if (op === 'sum') return numbers.reduce((total, value) => total + value, 0)
  if (op === 'avg') return numbers.reduce((total, value) => total + value, 0) / numbers.length
  return op === 'min' ? Math.min(...numbers) : Math.max(...numbers)
}

/** Assign `record[name] = value`, where a dotted name builds nested objects —
 *  so a Set-style field "billing.city" reads back as {{step.x.output.billing.city}}. */
function assignField(record: Record<string, unknown>, name: string, value: unknown) {
  const parts = name.split('.').map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) {
    record[name] = value
    return
  }
  let cursor = record
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {}
    cursor = cursor[part] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

/** Split a list into consecutive groups of at most `size` (loop batch size). */
export function chunkItems(items: unknown[], size: number): unknown[][] {
  const step = Math.max(1, Math.trunc(size))
  const chunks: unknown[][] = []
  for (let i = 0; i < items.length; i += step) chunks.push(items.slice(i, i + step))
  return chunks
}

// ── Date & Time helpers (all UTC — deterministic across machines/re-runs) ────

/** Read a date from a Date, ISO/parsable string, or epoch (seconds or millis). */
function parseDateInput(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input
  if (typeof input === 'number' && Number.isFinite(input)) {
    // Under ~Sep 33658 as millis ⇒ a value below 1e12 is epoch SECONDS.
    const date = new Date(Math.abs(input) < 1e12 ? input * 1000 : input)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return null
    if (/^-?\d+(\.\d+)?$/.test(text)) return parseDateInput(Number(text))
    const date = new Date(text)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** Render `date` through a pattern of YYYY/MM/DD/HH/mm/ss tokens (UTC). */
function formatUtcDate(date: Date, pattern: string): string {
  return pattern
    .replace(/YYYY/g, pad(date.getUTCFullYear(), 4))
    .replace(/MM/g, pad(date.getUTCMonth() + 1))
    .replace(/DD/g, pad(date.getUTCDate()))
    .replace(/HH/g, pad(date.getUTCHours()))
    .replace(/mm/g, pad(date.getUTCMinutes()))
    .replace(/ss/g, pad(date.getUTCSeconds()))
}

type DateUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years'

function normalizeDateUnit(raw: string | undefined): DateUnit | null {
  const unit = (raw ?? '').trim().toLowerCase().replace(/s$/, '')
  const map: Record<string, DateUnit> = {
    second: 'seconds', minute: 'minutes', hour: 'hours', day: 'days', week: 'weeks', month: 'months', year: 'years',
  }
  return map[unit] ?? null
}

const UNIT_MS: Record<Exclude<DateUnit, 'months' | 'years'>, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
}

/** Add `amount` of `unit` (negative subtracts). Month/year math clamps the day
 *  (Jan 31 + 1 month = Feb 28/29), matching calendar expectations, not rollover. */
function shiftUtcDate(date: Date, amount: number, unit: DateUnit): Date {
  if (unit !== 'months' && unit !== 'years') {
    return new Date(date.getTime() + amount * UNIT_MS[unit])
  }
  const months = unit === 'years' ? amount * 12 : amount
  const next = new Date(date.getTime())
  const day = next.getUTCDate()
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + Math.trunc(months))
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(day, lastDay))
  return next
}

/** Whole units between two dates, truncated toward zero; negative when end < start. */
function dateDifference(start: Date, end: Date, unit: DateUnit): number {
  if (unit !== 'months' && unit !== 'years') {
    return Math.trunc((end.getTime() - start.getTime()) / UNIT_MS[unit])
  }
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth())
  // A partial month doesn't count: 31 Jan → 28 Feb is 0 months, not 1.
  if (months > 0 && end.getUTCDate() < start.getUTCDate()) months -= 1
  if (months < 0 && end.getUTCDate() > start.getUTCDate()) months += 1
  return unit === 'years' ? Math.trunc(months / 12) : months
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function datePartValue(date: Date, part: string): string | number | undefined {
  switch (part) {
    case 'year': return date.getUTCFullYear()
    case 'month': return date.getUTCMonth() + 1
    case 'day': return date.getUTCDate()
    case 'hour': return date.getUTCHours()
    case 'minute': return date.getUTCMinutes()
    case 'second': return date.getUTCSeconds()
    case 'weekday': return WEEKDAYS[date.getUTCDay()]
    case 'date': return formatUtcDate(date, 'YYYY-MM-DD')
    case 'time': return formatUtcDate(date, 'HH:mm')
    default: return undefined
  }
}

// ── Markdown ⇄ HTML (dependency-free GFM subset, escape-first for safety) ────

/** Only link targets that can't smuggle script execute as links. */
const SAFE_URL_RE = /^(https?:|mailto:|#|\/)/i

/** Inline markdown → HTML for one already-ESCAPED text run. */
function inlineMarkdown(escaped: string): string {
  // Protect inline code spans first so nothing inside them is transformed.
  const codeSpans: string[] = []
  let text = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return ` ${codeSpans.length - 1} `
  })
  text = text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => (SAFE_URL_RE.test(url) ? `<img src="${url}" alt="${alt}">` : m))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => (SAFE_URL_RE.test(url) ? `<a href="${url}">${label}</a>` : m))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  return text.replace(/ (\d+) /g, (_m, index: string) => codeSpans[Number(index)])
}

function markdownTable(lines: string[]): string | null {
  if (lines.length < 2) return null
  const isRow = (line: string) => line.trim().startsWith('|') || line.includes('|')
  if (!isRow(lines[0]) || !/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]) || !lines[1].includes('-')) return null
  const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => inlineMarkdown(cell.trim()))
  const head = `<tr>${cells(lines[0]).map((cell) => `<th>${cell}</th>`).join('')}</tr>`
  const body = lines.slice(2).filter(isRow).map((line) => `<tr>${cells(line).map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`
}

/** Markdown → HTML: headings, lists, quotes, fences, tables, inline marks.
 *  Raw HTML in the source is escaped, never passed through — the output is safe
 *  to drop into an email body or page. */
function markdownToHtml(markdown: string): string {
  const source = markdown.replace(/\r\n/g, '\n')
  // Pull fenced code blocks out before any other processing.
  const fences: string[] = []
  const withoutFences = source.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    fences.push(`<pre><code>${htmlEscape(code.replace(/\n$/, ''))}</code></pre>`)
    return `${fences.length - 1}`
  })
  const blocks = withoutFences.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean)
  const html = blocks.map((block) => {
    const fence = block.match(/^(\d+)$/)
    if (fence) return fences[Number(fence[1])]
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) return '<hr>'
    const lines = block.split('\n')
    const escapedLines = lines.map((line) => htmlEscape(line))
    const heading = block.match(/^(#{1,6})\s+(.*)$/s)
    if (heading && !block.includes('\n')) {
      const level = heading[1].length
      return `<h${level}>${inlineMarkdown(htmlEscape(heading[2].trim()))}</h${level}>`
    }
    if (lines.every((line) => line.trim().startsWith('>'))) {
      const inner = lines.map((line) => inlineMarkdown(htmlEscape(line.replace(/^\s*>\s?/, '')))).join('<br>')
      return `<blockquote>${inner}</blockquote>`
    }
    const table = markdownTable(lines)
    if (table) return table
    if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
      const items = lines.map((line) => `<li>${inlineMarkdown(htmlEscape(line.replace(/^\s*[-*+]\s+/, '')))}</li>`).join('')
      return `<ul>${items}</ul>`
    }
    if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
      const items = lines.map((line) => `<li>${inlineMarkdown(htmlEscape(line.replace(/^\s*\d+\.\s+/, '')))}</li>`).join('')
      return `<ol>${items}</ol>`
    }
    return `<p>${escapedLines.map((line) => inlineMarkdown(line)).join('<br>')}</p>`
  })
  return html.join('\n')
}

/** Decode the entities the converter (and common HTML) emits. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** HTML → Markdown: the common structural tags; anything unknown is stripped. */
function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi, (_m, code: string) => `\n\n\`\`\`\n${decodeEntities(code).trim()}\n\`\`\`\n\n`)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.trim()}\n\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*>/gi, '![$1]($2)')
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => `\n\n${inner.trim().split('\n').map((line: string) => `> ${line.trim()}`).join('\n')}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inner.trim()}`)
    .replace(/<\/(ul|ol|table)>/gi, '\n\n')
    .replace(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi, '$2 | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')
    .replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── XML ⇄ JSON (dependency-free, non-validating) ─────────────────────────────

type XmlValue = string | XmlObject | XmlValue[]
type XmlObject = { [key: string]: XmlValue }

/** Merge a child under `name`: repeated sibling names collapse into an array. */
function addXmlChild(parent: XmlObject, name: string, value: XmlValue) {
  const existing = parent[name]
  if (existing === undefined) parent[name] = value
  else if (Array.isArray(existing) && !(name in { '@': 1 })) (existing as XmlValue[]).push(value)
  else parent[name] = [existing as XmlValue, value]
}

/**
 * XML text → plain JSON: element children become keys (repeats become arrays),
 * attributes keep an `@` prefix, and an element with only text collapses to a
 * string (`#text` holds the text when attributes/children sit alongside it).
 */
function parseXml(xml: string): XmlObject {
  let i = 0
  const text = xml.trim()
  const fail = (message: string): never => { throw new Error(message) }

  const skipMisc = () => {
    for (;;) {
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i)
        if (end === -1) fail('an XML declaration never closes')
        i = end + 2
      } else if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i)
        if (end === -1) fail('a comment never closes')
        i = end + 3
      } else if (text.startsWith('<!DOCTYPE', i) || text.startsWith('<!doctype', i)) {
        const end = text.indexOf('>', i)
        if (end === -1) fail('the DOCTYPE never closes')
        i = end + 1
      } else if (/\s/.test(text[i] ?? '')) {
        i += 1
      } else {
        return
      }
    }
  }

  const parseElement = (): { name: string; value: XmlValue } => {
    if (text[i] !== '<') fail('expected an element')
    const open = text.slice(i).match(/^<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/)
    if (!open) fail(`malformed tag near "${text.slice(i, i + 40)}"`)
    const [matched, name, attrText, selfClose] = open!
    i += matched.length
    const node: XmlObject = {}
    for (const attr of attrText.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      node[`@${attr[1]}`] = decodeEntities(attr[2] ?? attr[3] ?? '')
    }
    if (selfClose) return { name, value: Object.keys(node).length ? node : '' }
    let textContent = ''
    let hasChildren = false
    for (;;) {
      if (i >= text.length) fail(`<${name}> never closes`)
      if (text.startsWith(`</`, i)) {
        const close = text.slice(i).match(/^<\/\s*([\w.:-]+)\s*>/)
        if (!close || close[1] !== name) fail(`<${name}> is closed by </${close?.[1] ?? '?'}>`)
        i += close![0].length
        break
      }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i)
        if (end === -1) fail('a CDATA section never closes')
        textContent += text.slice(i + 9, end)
        i = end + 3
        continue
      }
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i)
        if (end === -1) fail('a comment never closes')
        i = end + 3
        continue
      }
      if (text[i] === '<') {
        hasChildren = true
        const child = parseElement()
        addXmlChild(node, child.name, child.value)
        continue
      }
      const next = text.indexOf('<', i)
      const chunk = next === -1 ? text.slice(i) : text.slice(i, next)
      textContent += chunk
      i += chunk.length
    }
    const trimmed = decodeEntities(textContent).trim()
    const hasAttrs = Object.keys(node).some((key) => key.startsWith('@'))
    if (!hasChildren && !hasAttrs) return { name, value: trimmed }
    if (trimmed) node['#text'] = trimmed
    return { name, value: node }
  }

  skipMisc()
  if (i >= text.length) fail('the content is empty')
  const root = parseElement()
  skipMisc()
  if (i < text.length) fail('content continues after the root element closes')
  return { [root.name]: root.value }
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A JSON value → XML element(s). `@keys` become attributes, `#text` the text. */
function buildXmlElement(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => buildXmlElement(name, entry)).join('')
  if (value === null || value === undefined) return `<${name}/>`
  if (typeof value !== 'object') return `<${name}>${xmlEscape(String(value))}</${name}>`
  const record = value as Record<string, unknown>
  const attrs = Object.entries(record)
    .filter(([key]) => key.startsWith('@'))
    .map(([key, attr]) => ` ${key.slice(1)}="${xmlEscape(String(attr ?? ''))}"`)
    .join('')
  const children = Object.entries(record)
    .filter(([key]) => !key.startsWith('@') && key !== '#text')
    .map(([key, child]) => buildXmlElement(key, child))
    .join('')
  const textContent = record['#text'] === undefined ? '' : xmlEscape(String(record['#text']))
  const inner = `${textContent}${children}`
  return inner ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs}/>`
}

/** An object → an XML document: a single key becomes the root, else <root> wraps. */
function buildXmlDocument(value: Record<string, unknown>): string {
  const keys = Object.keys(value)
  const body = keys.length === 1 && !keys[0].startsWith('@') && keys[0] !== '#text'
    ? buildXmlElement(keys[0], value[keys[0]])
    : buildXmlElement('root', value)
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`
}

/**
 * Coerce a resolved value to a field's declared type (n8n's per-field type
 * dropdown). A value that cannot honestly become the requested type is returned
 * UNCHANGED rather than nulled, so a mistyped field shows up in the output
 * instead of vanishing.
 */
export function coerceFieldType(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return value
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isNaN(n) ? value : n
    }
    case 'boolean': {
      const text = String(value).trim().toLowerCase()
      if (['true', 'yes', '1'].includes(text)) return true
      if (['false', 'no', '0'].includes(text)) return false
      return value
    }
    case 'array':
      return Array.isArray(value) ? value : [value]
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value) ? value : value
    default:
      return value
  }
}
