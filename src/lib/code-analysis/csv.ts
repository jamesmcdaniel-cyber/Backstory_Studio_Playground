/**
 * RFC 4180-ish delimited-text parsing for the code-analysis plane.
 *
 * A repository CSV is stored as raw text. Parsing it here, host-side, means an
 * agent's code receives ready rows instead of having to hand-roll a parser in
 * a sandbox that (deliberately) cannot import `csv`. Values stay strings —
 * coercion is the analysis code's call (`to_number`), because an id with a
 * leading zero or a zip code must not silently become a number.
 */

export function isTabular(filename: string): boolean {
  return /\.(csv|tsv)$/i.test(filename)
}

function detectDelimiter(text: string, filename: string): string {
  if (/\.tsv$/i.test(filename)) return '\t'
  const header = text.slice(0, text.search(/\r?\n|$/))
  return header.includes('\t') && !header.includes(',') ? '\t' : ','
}

function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1 } else quoted = false
      } else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { record.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      record.push(field); field = ''
      records.push(record); record = []
    } else field += ch
  }
  if (field !== '' || record.length) { record.push(field); records.push(record) }
  // Blank lines carry no data.
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ''))
}

function uniqueColumns(header: string[]): string[] {
  const seen = new Map<string, number>()
  return header.map((raw, index) => {
    const base = raw.trim() || `column_${index + 1}`
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    return count === 1 ? base : `${base}_${count}`
  })
}

export function parseDelimited(text: string, filename: string): { columns: string[]; rows: Record<string, string>[] } {
  const clean = text.replace(/^﻿/, '')
  const [header = [], ...body] = parseRecords(clean, detectDelimiter(clean, filename))
  const columns = uniqueColumns(header)
  const rows = body.map((record) => Object.fromEntries(columns.map((column, index) => [column, record[index] ?? ''])))
  return { columns, rows }
}
