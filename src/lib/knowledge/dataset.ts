import { parseDelimited } from '@/lib/code-analysis/csv'

/**
 * Dataset profiling — what the repository indexes about a tabular file
 * instead of its text.
 *
 * A 25 MB activity extract has no business in an embedding index: nobody
 * semantically searches a fact table, and the first 200K characters of it
 * (the old ingest path) told an agent nothing true about the whole. What an
 * agent needs to know is what the file *is* — its columns, their types and
 * ranges, how many rows, what a row looks like — so it can decide to load it
 * into `run_code`. That description is small, embeds well, and is exact.
 *
 * The head of the file is parsed properly (quotes, embedded delimiters) for
 * samples and type inference; the row count comes from a quote-aware scan of
 * the whole buffer that never materialises records.
 */

export const DATASET_SAMPLE_ROWS = 5_000
export const DATASET_PREVIEW_ROWS = 10
const PROFILE_HEAD_BYTES = 4_000_000
const LOW_CARDINALITY = 20

export type DatasetColumnType = 'number' | 'date' | 'boolean' | 'text' | 'empty'

export type DatasetColumn = {
  name: string
  type: DatasetColumnType
  /** Rows in the sampled head with no value. */
  empty: number
  min?: number | string
  max?: number | string
  /** Every distinct value, when the column has few of them (a status, a team, a stage). */
  values?: string[]
  /** Distinct values seen in the sampled head. */
  distinct: number
}

export type DatasetProfile = {
  filename: string
  delimiter: ',' | '\t'
  rowCount: number
  /** How many rows types/ranges were inferred from; equals rowCount for small files. */
  sampledRows: number
  columns: DatasetColumn[]
  sample: Record<string, string>[]
  bytes: number
}

function countRecords(text: string, delimiter: string): number {
  // Newlines inside quoted fields are not record boundaries.
  let count = 0
  let quoted = false
  let fieldStart = true
  let lineHasContent = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') i += 1
        else quoted = false
      }
      continue
    }
    if (ch === '"' && fieldStart) { quoted = true; lineHasContent = true; continue }
    if (ch === delimiter) { fieldStart = true; lineHasContent = true; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      if (lineHasContent) count += 1
      lineHasContent = false
      fieldStart = true
      continue
    }
    if (ch !== ' ' && ch !== '\t') lineHasContent = true
    fieldStart = false
  }
  if (lineHasContent) count += 1
  return count
}

const NUMBER = /^[-+]?\$?\(?[-+]?[\d,]*\.?\d+(e[-+]?\d+)?\)?%?$/i
const BOOLEAN = /^(true|false|yes|no|y|n|t|f)$/i
const DATE = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}\/\d{1,2}\/\d{1,2})([ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/

function toNumber(value: string): number {
  const negative = /^\(.*\)$/.test(value)
  const cleaned = value.replace(/[$,%()\s]/g, '')
  const parsed = Number(cleaned)
  return negative ? -parsed : parsed
}

function toDateKey(value: string): string | null {
  const text = value.trim()
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text)
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text)
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3]
    return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`
  }
  return null
}

function inferColumn(name: string, values: string[]): DatasetColumn {
  const present = values.filter((value) => value.trim() !== '')
  const empty = values.length - present.length
  const distinctSet = new Set(present)
  const distinct = distinctSet.size
  const base = { name, empty, distinct }
  if (!present.length) return { ...base, type: 'empty' }
  const share = (test: (value: string) => boolean) => present.filter(test).length / present.length
  if (share((v) => BOOLEAN.test(v.trim())) >= 0.98) {
    return { ...base, type: 'boolean', values: [...distinctSet].slice(0, LOW_CARDINALITY) }
  }
  if (share((v) => DATE.test(v.trim())) >= 0.95) {
    const keys = present.map(toDateKey).filter((key): key is string => Boolean(key)).sort()
    return { ...base, type: 'date', min: keys[0], max: keys[keys.length - 1] }
  }
  if (share((v) => NUMBER.test(v.trim())) >= 0.95) {
    const numbers = present.map((v) => toNumber(v.trim())).filter((n) => Number.isFinite(n))
    return { ...base, type: 'number', min: Math.min(...numbers), max: Math.max(...numbers) }
  }
  return {
    ...base,
    type: 'text',
    ...(distinct <= LOW_CARDINALITY ? { values: [...distinctSet].sort() } : {}),
  }
}

export function profileDataset(buffer: Buffer, filename: string): DatasetProfile {
  const delimiter: ',' | '\t' = /\.tsv$/i.test(filename) ? '\t' : ','
  const wholeText = buffer.toString('utf8').replace(/^﻿/, '')
  const records = countRecords(wholeText, delimiter)
  const rowCount = Math.max(0, records - 1)

  // Parse only the head for samples: enough bytes for DATASET_SAMPLE_ROWS of
  // even a wide extract, cut back to the last complete line.
  let headText = buffer.length > PROFILE_HEAD_BYTES ? wholeText.slice(0, PROFILE_HEAD_BYTES) : wholeText
  if (buffer.length > PROFILE_HEAD_BYTES) headText = headText.slice(0, headText.lastIndexOf('\n') + 1)
  const { columns: names, rows } = parseDelimited(headText, filename)
  const sampled = rows.slice(0, DATASET_SAMPLE_ROWS)
  const columns = names.map((name) => inferColumn(name, sampled.map((row) => row[name] ?? '')))
  return {
    filename,
    delimiter,
    rowCount,
    sampledRows: Math.min(rowCount, sampled.length),
    columns,
    sample: rows.slice(0, DATASET_PREVIEW_ROWS),
    bytes: buffer.length,
  }
}

function formatBound(value: number | string | undefined): string {
  if (value === undefined) return ''
  return typeof value === 'number' ? String(Number(value.toFixed(4))) : value
}

/** The indexed, human-readable description of a dataset. Read by agents via
 *  repository_read and searched via repository_search; short by design. */
export function datasetProfileText(profile: DatasetProfile): string {
  const lines: string[] = []
  lines.push(`Dataset: ${profile.filename}`)
  const sampledNote = profile.sampledRows < profile.rowCount ? ` (types and ranges inferred from the first ${profile.sampledRows.toLocaleString()})` : ''
  lines.push(`${profile.rowCount.toLocaleString()} rows × ${profile.columns.length} columns, ${(profile.bytes / 1_000_000).toFixed(1)} MB${sampledNote}. Load it with run_code to compute over it; this profile is a description, not the data.`)
  lines.push('')
  lines.push('Columns:')
  for (const column of profile.columns) {
    const parts: string[] = [column.type]
    if (column.type === 'number' || column.type === 'date') parts.push(`${formatBound(column.min)} – ${formatBound(column.max)}`)
    if (column.empty) parts.push(`${column.empty} empty`)
    let line = `- ${column.name} (${parts.join(', ')})`
    if (column.type === 'text' && column.values?.length) line += `: ${column.values.join(', ')}`
    lines.push(line)
  }
  if (profile.sample.length) {
    lines.push('')
    lines.push(`First ${Math.min(3, profile.sample.length)} rows:`)
    for (const row of profile.sample.slice(0, 3)) {
      lines.push(`- ${profile.columns.map((column) => `${column.name}=${row[column.name] ?? ''}`).join('; ')}`)
    }
  }
  return lines.join('\n')
}
