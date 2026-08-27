import { dataTableColumnsSchema, normalizeDataTableRow, type DataTableColumn } from '@/lib/data-tables/schema'

const csvEscape = (value: string): string => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** Prevent spreadsheet applications from evaluating imported customer data. */
function spreadsheetSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function dataTableRowsToCsv(
  rows: Array<Record<string, unknown>>,
  columnsValue: unknown,
  options: { formulaSafe?: boolean } = {},
): string {
  const columns = dataTableColumnsSchema.parse(columnsValue)
  const headers = columns.length
    ? columns.map((column) => column.name)
    : [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const safe = options.formulaSafe !== false
  const render = (value: unknown) => csvEscape(safe ? spreadsheetSafe(cellText(value)) : cellText(value))
  return [headers.map(csvEscape).join(','), ...rows.map((row) => headers.map((header) => render(row[header])).join(','))].join('\n')
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"'
          index++
        } else {
          quoted = false
        }
      } else {
        cell += character
      }
    } else if (character === '"' && cell.length === 0) {
      quoted = true
    } else if (character === ',') {
      row.push(cell)
      cell = ''
    } else if (character === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.')
  if (cell.length || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((entry, index) => index === 0 || entry.some((value) => value !== ''))
}

function parseCell(raw: string, column?: DataTableColumn): unknown {
  if (!column || column.type === 'string') return raw
  if (raw === '') {
    if (!column.required) return null
    throw new Error(`Column "${column.name}" cannot be blank.`)
  }
  if (column.type === 'date' || column.type === 'dateTime') return raw
  if (column.type === 'number') {
    const number = Number(raw)
    if (!Number.isFinite(number)) throw new Error(`Column "${column.name}" contains a non-number value.`)
    return number
  }
  if (column.type === 'boolean') {
    if (/^(true|1|yes)$/i.test(raw)) return true
    if (/^(false|0|no)$/i.test(raw)) return false
    throw new Error(`Column "${column.name}" contains a non-boolean value.`)
  }
  if (column.type === 'object' || column.type === 'array') {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`Column "${column.name}" must contain valid JSON.`)
    }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function csvToDataTableRows(text: string, columnsValue: unknown): Array<Record<string, unknown>> {
  const rows = parseCsvRows(text)
  if (!rows.length || !rows[0].some((header) => header.trim())) throw new Error('CSV needs a header row.')
  if (rows.length > 10_001) throw new Error('CSV import is limited to 10,000 data rows.')
  const headers = rows[0].map((header) => header.trim())
  if (headers.some((header) => !header)) throw new Error('CSV headers cannot be blank.')
  if (new Set(headers.map((header) => header.toLocaleLowerCase())).size !== headers.length) {
    throw new Error('CSV headers must be unique.')
  }
  const columns = dataTableColumnsSchema.parse(columnsValue)
  const byName = new Map(columns.map((column) => [column.name, column]))
  if (columns.length) {
    const unknown = headers.filter((header) => !byName.has(header))
    if (unknown.length) throw new Error(`Unknown data-table column${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`)
  }
  return rows.slice(1).map((cells, index) => {
    if (cells.length > headers.length) throw new Error(`CSV row ${index + 2} has more values than the header.`)
    const raw = Object.fromEntries(headers.map((header, columnIndex) => [header, parseCell(cells[columnIndex] ?? '', byName.get(header))]))
    return normalizeDataTableRow(raw, columns)
  })
}
