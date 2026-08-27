import { z } from 'zod'

export const DATA_TABLE_COLUMN_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'dateTime',
  'object',
  'array',
  'any',
] as const

export const dataTableColumnSchema = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'Column names must start with a letter or underscore.'),
  label: z.string().trim().min(1).max(120).optional(),
  type: z.enum(DATA_TABLE_COLUMN_TYPES).default('string'),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
}).strict()

export const dataTableColumnsSchema = z.array(dataTableColumnSchema).max(200).superRefine((columns, ctx) => {
  const names = new Set<string>()
  for (const [index, column] of columns.entries()) {
    const key = column.name.toLocaleLowerCase()
    if (names.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'name'], message: 'Column names must be unique.' })
    names.add(key)
  }
})

export type DataTableColumn = z.infer<typeof dataTableColumnSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function valueMatches(type: DataTableColumn['type'], value: unknown): boolean {
  if (type === 'any') return true
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  if (type === 'date') return isCalendarDate(value)
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Validate and default one row against the table's persisted schema. */
export function normalizeDataTableRow(
  input: unknown,
  columnsValue: unknown,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  if (!isRecord(input)) throw new Error('A data-table row must be a JSON object.')
  const columns = dataTableColumnsSchema.parse(columnsValue)
  // An empty schema is intentionally schemaless: useful for imported tables
  // and still bounded by route/body/row limits.
  if (!columns.length) return { ...input }
  const byName = new Map(columns.map((column) => [column.name, column]))
  const unknown = Object.keys(input).filter((name) => !byName.has(name))
  if (unknown.length) throw new Error(`Unknown data-table column${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`)

  const output: Record<string, unknown> = {}
  for (const column of columns) {
    let value = input[column.name]
    if (value === undefined && !options.partial && column.default !== undefined) value = column.default
    if (value === undefined) {
      if (!options.partial && column.required) throw new Error(`Column "${column.label ?? column.name}" is required.`)
      continue
    }
    if (value === null) {
      if (column.required) throw new Error(`Column "${column.label ?? column.name}" cannot be null.`)
      output[column.name] = null
      continue
    }
    if (!valueMatches(column.type, value)) {
      throw new Error(`Column "${column.label ?? column.name}" must be ${column.type}.`)
    }
    output[column.name] = value
  }
  return output
}

export function dataTableRowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key]
    return typeof expected === 'object'
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : Object.is(actual, expected)
  })
}
