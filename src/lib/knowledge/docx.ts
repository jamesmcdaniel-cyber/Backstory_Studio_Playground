/**
 * DOCX → markdown-shaped text + core metadata, with no third-party parser: a
 * .docx is a ZIP whose `word/document.xml` holds the body in reading order. We
 * read that entry (central directory → local header → raw inflate via
 * node:zlib), plus `word/styles.xml` (which styles are headings) and
 * `docProps/core.xml` (title, author, dates) when present, and walk the XML for
 * text runs, headings, paragraph/line breaks, list markers, and tables.
 *
 * Why not mammoth: it pulls in a JSZip/xmldom/bluebird tree to produce HTML we
 * would then have to turn back into text, and it does not read core metadata.
 * This reader is ~400 lines, has no dependencies, and is bounded by the size
 * caps below and DOCX_EXTRACT_TIME_LIMIT_MS.
 *
 * Deliberately narrow: no images, headers/footers, footnotes, or
 * tracked-change reconciliation (accepted text wins, deletions are dropped).
 * Anything we cannot read confidently throws DocxExtractionError so the caller
 * rejects the upload outright — never a silent partial extraction.
 */

import { inflateRawSync } from 'node:zlib'

export class DocxExtractionError extends Error {}

/** Ceiling on the inflated document part — guards against zip bombs. */
const MAX_PART_BYTES = 32 * 1024 * 1024
/** Ceiling on emitted text; the ingest path caps again at its own MAX_CHARS. */
const MAX_TEXT_CHARS = 2_000_000

// The OOXML word-processing types only. Legacy binary .doc (application/msword)
// is a different container entirely and stays unsupported.
const DOCX_MIME = /officedocument\.wordprocessingml\.(document|template)/i

/** Whether this looks like a DOCX by mime type or extension. */
export function isDocx(mimeType: string, filename: string): boolean {
  return DOCX_MIME.test(mimeType) || /\.docx$/i.test(filename)
}

// ── ZIP reading (single named entry) ────────────────────────────────────────

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(buf: Buffer): number {
  // The EOCD is at most 22 + 65535 bytes from the end (comment field).
  const start = Math.max(0, buf.length - (22 + 0xffff))
  for (let i = buf.length - 22; i >= start; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

type ZipEntry = { name: string; method: number; compressedSize: number; localHeaderOffset: number }

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new DocxExtractionError('That file is not a readable .docx — its ZIP structure is missing or damaged.')
  let entryCount = buf.readUInt16LE(eocd + 10)
  let cenOffset = buf.readUInt32LE(eocd + 16)
  // ZIP64: the 32-bit fields saturate and the real values live in the ZIP64 EOCD.
  if (cenOffset === 0xffffffff || entryCount === 0xffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== EOCD64_LOCATOR_SIG) {
      throw new DocxExtractionError('That .docx uses a ZIP64 layout this reader cannot follow. Re-save it from Word and try again.')
    }
    const eocd64 = Number(buf.readBigUInt64LE(locator + 8))
    if (eocd64 < 0 || eocd64 + 56 > buf.length) throw new DocxExtractionError('That .docx has a damaged ZIP directory.')
    entryCount = Number(buf.readBigUInt64LE(eocd64 + 32))
    cenOffset = Number(buf.readBigUInt64LE(eocd64 + 48))
  }
  const entries: ZipEntry[] = []
  let pointer = cenOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (pointer + 46 > buf.length || buf.readUInt32LE(pointer) !== CEN_SIG) {
      throw new DocxExtractionError('That .docx has a damaged ZIP directory.')
    }
    const flags = buf.readUInt16LE(pointer + 8)
    const method = buf.readUInt16LE(pointer + 10)
    const compressedSize = buf.readUInt32LE(pointer + 20)
    const nameLength = buf.readUInt16LE(pointer + 28)
    const extraLength = buf.readUInt16LE(pointer + 30)
    const commentLength = buf.readUInt16LE(pointer + 32)
    const localHeaderOffset = buf.readUInt32LE(pointer + 42)
    const name = buf.toString('utf-8', pointer + 46, pointer + 46 + nameLength)
    // Bit 0 = the entry is encrypted.
    if (flags & 0x1) throw new DocxExtractionError('That .docx is password-protected. Remove the password and upload it again.')
    entries.push({ name, method, compressedSize, localHeaderOffset })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== LOC_SIG) {
    throw new DocxExtractionError('That .docx has a damaged ZIP entry and could not be read.')
  }
  const nameLength = buf.readUInt16LE(offset + 26)
  const extraLength = buf.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  // The local header's size fields are 0 when a data descriptor follows, so the
  // central directory's compressed size is the authoritative one.
  const end = entry.compressedSize > 0 ? dataStart + entry.compressedSize : buf.length
  if (dataStart > buf.length || end > buf.length) {
    throw new DocxExtractionError('That .docx has a damaged ZIP entry and could not be read.')
  }
  const raw = buf.subarray(dataStart, end)
  if (entry.method === 0) {
    if (raw.length > MAX_PART_BYTES) throw new DocxExtractionError('That .docx document body is too large to read.')
    return raw
  }
  if (entry.method !== 8) {
    throw new DocxExtractionError(`That .docx uses an unsupported ZIP compression method (${entry.method}).`)
  }
  try {
    return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/maxOutputLength|buffer/i.test(message)) {
      throw new DocxExtractionError('That .docx document body is too large to read.')
    }
    throw new DocxExtractionError('That .docx could not be decompressed — the file looks corrupt.')
  }
}

// ── XML → text ─────────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}


/** Wall-clock budget for one document walk — a pathological XML part fails
 *  cleanly instead of pinning the worker (the size caps above bound memory). */
export const DOCX_EXTRACT_TIME_LIMIT_MS = 10_000

/** A tag's `w:val` attribute, or undefined. */
function attrVal(tag: string): string | undefined {
  const match = /\bw:val="([^"]*)"/.exec(tag)
  return match ? decodeEntities(match[1]) : undefined
}

/** Heading level a paragraph style id carries by Word's built-in naming. */
function builtinHeadingLevel(styleId: string): number | undefined {
  if (/^title$/i.test(styleId)) return 1
  if (/^subtitle$/i.test(styleId)) return 2
  const match = /^heading\s?([1-9])$/i.exec(styleId)
  return match ? Math.min(6, Number(match[1])) : undefined
}

/**
 * Paragraph style id → heading level, read from `word/styles.xml`. Style ids
 * are localized (a German document's Heading 1 is `berschrift1`), but each
 * style's `w:name` keeps the built-in English name ("heading 1") and an
 * outline level, so both are consulted. Best-effort: no styles part, or one we
 * cannot read, just means only the built-in ids are recognized.
 */
export function headingStylesFromXml(xml: string): Map<string, number> {
  const levels = new Map<string, number>()
  const styleRe = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g
  let match: RegExpExecArray | null
  while ((match = styleRe.exec(xml))) {
    const attrs = match[1]
    if (!/\bw:type="paragraph"/.test(attrs)) continue
    const id = /\bw:styleId="([^"]*)"/.exec(attrs)?.[1]
    if (!id) continue
    const body = match[2]
    const name = /<w:name\b[^>]*\bw:val="([^"]*)"/.exec(body)?.[1] ?? ''
    const outline = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(body)?.[1]
    const level =
      builtinHeadingLevel(name.replace(/\s+/g, ' ').trim()) ??
      (outline !== undefined && Number(outline) < 9 ? Math.min(6, Number(outline) + 1) : undefined)
    if (level) levels.set(id, level)
  }
  return levels
}

/** One markdown table cell: pipes escaped, kept on one line. */
function markdownCell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

/** Rows → a GitHub-flavoured markdown table (first row is the header). */
export function markdownTable(rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map((row) => row.length))
  if (!width) return []
  const pad = (row: string[]) => Array.from({ length: width }, (_unused, index) => markdownCell(row[index] ?? ''))
  const [header, ...rest] = rows
  return [
    `| ${pad(header).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rest.map((row) => `| ${pad(row).join(' | ')} |`),
  ]
}

type TableState = { rows: string[][]; row: string[] | null }

/**
 * Walk `word/document.xml` in document order. WordprocessingML is a flat,
 * well-ordered tag stream for our purposes, so a tokenizing scan (rather than a
 * DOM) keeps this dependency-free and linear in the document size.
 *
 * Output is markdown-shaped plain text, because that is what both a reader and
 * a retrieval index make best use of: one line per paragraph, `#`-prefixed
 * headings (by built-in style, localized style name, or outline level), "- " in
 * front of numbered/bulleted paragraphs, tables as markdown tables (a table
 * nested in a cell is flattened into that cell), tabs and manual line breaks
 * inside a paragraph. Tracked deletions (<w:del>) are dropped.
 */
export function documentXmlToText(
  xml: string,
  opts: { headingStyles?: Map<string, number>; deadline?: number } = {},
): string {
  const deadline = opts.deadline ?? Date.now() + DOCX_EXTRACT_TIME_LIMIT_MS
  const lines: string[] = []
  const tables: TableState[] = []
  /** Paragraphs collected inside the innermost open <w:tc>. */
  const cellStack: string[][] = []
  let paragraph: string[] = []
  let paragraphIsListItem = false
  let headingLevel: number | undefined
  let inDeleted = 0
  let inText = false
  let inParagraphProps = false

  const flushParagraph = () => {
    const line = paragraph.join('').replace(/[ \t]+$/g, '')
    paragraph = []
    const inCell = cellStack.length > 0
    const isHeading = Boolean(headingLevel && line.trim() && !inCell)
    let marked = line
    if (isHeading) marked = `${'#'.repeat(headingLevel ?? 1)} ${line.trim()}`
    // List markers do not survive inside a markdown table cell either.
    else if (paragraphIsListItem && line.trim() && !inCell) marked = `- ${line.replace(/^\s+/, '')}`
    paragraphIsListItem = false
    headingLevel = undefined
    if (inCell) {
      cellStack[cellStack.length - 1].push(marked)
      return
    }
    // A heading reads as its own block in markdown.
    if (isHeading && lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push(marked)
  }

  const tagRe = /<[^>]*>/g
  let match: RegExpExecArray | null
  let cursor = 0
  let tags = 0
  while ((match = tagRe.exec(xml))) {
    if ((++tags & 0x7ff) === 0 && Date.now() > deadline) {
      throw new DocxExtractionError('That .docx took too long to read — it may be malformed. Re-save it from Word and try again.')
    }
    if (inText && !inDeleted && match.index > cursor) {
      paragraph.push(decodeEntities(xml.slice(cursor, match.index)))
    }
    cursor = tagRe.lastIndex
    const inner = match[0].slice(1, -1)
    // Ignore XML declarations, comments, and processing instructions.
    if (inner.startsWith('?') || inner.startsWith('!')) continue
    const closing = inner.startsWith('/')
    const selfClosing = inner.endsWith('/')
    const name = inner.replace(/^\//, '').replace(/\/$/, '').trim().split(/[\s/]/)[0]

    switch (name) {
      case 'w:t':
        inText = !closing && !selfClosing
        break
      case 'w:del':
        if (selfClosing) break
        if (closing) inDeleted = Math.max(0, inDeleted - 1)
        else inDeleted += 1
        break
      case 'w:tab':
        // A <w:tab> inside paragraph properties is a tab STOP, not text.
        if (!closing && !inDeleted && !inParagraphProps) paragraph.push('\t')
        break
      case 'w:br':
      case 'w:cr':
        if (!closing && !inDeleted) paragraph.push('\n')
        break
      case 'w:pPr':
        if (!selfClosing) inParagraphProps = !closing
        break
      case 'w:numPr':
        if (!closing) paragraphIsListItem = true
        break
      case 'w:pStyle':
        if (!closing) {
          const styleId = attrVal(inner) ?? ''
          headingLevel = opts.headingStyles?.get(styleId) ?? builtinHeadingLevel(styleId) ?? headingLevel
        }
        break
      case 'w:outlineLvl':
        if (!closing && inParagraphProps && headingLevel === undefined) {
          const level = Number(attrVal(inner))
          if (Number.isInteger(level) && level >= 0 && level < 9) headingLevel = Math.min(6, level + 1)
        }
        break
      case 'w:p':
        if (selfClosing) break
        if (closing) flushParagraph()
        else {
          paragraph = []
          paragraphIsListItem = false
          headingLevel = undefined
        }
        break
      case 'w:tbl': {
        if (selfClosing) break
        if (!closing) {
          tables.push({ rows: [], row: null })
          break
        }
        const table = tables.pop()
        if (!table || !table.rows.length) break
        if (cellStack.length) {
          // Nested table: flatten it into the enclosing cell rather than break
          // the outer markdown table.
          cellStack[cellStack.length - 1].push(table.rows.map((row) => row.filter(Boolean).join(' / ')).join('; '))
        } else {
          if (lines.length && lines[lines.length - 1] !== '') lines.push('')
          lines.push(...markdownTable(table.rows), '')
        }
        break
      }
      case 'w:tr': {
        const table = tables[tables.length - 1]
        if (selfClosing || !table) break
        if (closing) {
          if (table.row && table.row.some((cell) => cell.trim())) table.rows.push(table.row)
          table.row = null
        } else {
          table.row = []
        }
        break
      }
      case 'w:tc': {
        if (selfClosing) break
        if (!closing) {
          cellStack.push([])
          break
        }
        const paragraphs = cellStack.pop() ?? []
        const cell = paragraphs.map((entry) => entry.trim()).filter(Boolean).join(' ')
        const table = tables[tables.length - 1]
        if (table?.row) table.row.push(cell)
        break
      }
      default:
        break
    }
    if (lines.length > 500_000) break
  }
  // An unterminated final paragraph still carries text worth keeping.
  if (paragraph.length) flushParagraph()

  return lines
    .join('\n')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}

// ── Core metadata (docProps/core.xml) ──────────────────────────────────────

/** Dublin Core / OPC core properties a Word file carries. All optional. */
export type DocxMetadata = {
  title?: string
  subject?: string
  author?: string
  keywords?: string
  description?: string
  category?: string
  lastModifiedBy?: string
  revision?: string
  created?: string
  modified?: string
}

const CORE_FIELDS: Array<[keyof DocxMetadata, string]> = [
  ['title', 'dc:title'],
  ['subject', 'dc:subject'],
  ['author', 'dc:creator'],
  ['keywords', 'cp:keywords'],
  ['description', 'dc:description'],
  ['category', 'cp:category'],
  ['lastModifiedBy', 'cp:lastModifiedBy'],
  ['revision', 'cp:revision'],
  ['created', 'dcterms:created'],
  ['modified', 'dcterms:modified'],
]

/** Longest value kept per field — metadata is a label, not a second body. */
const META_FIELD_MAX = 500

export function coreMetadataFromXml(xml: string): DocxMetadata {
  const out: DocxMetadata = {}
  for (const [key, tag] of CORE_FIELDS) {
    const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
    const value = match ? decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : ''
    if (value) out[key] = value.slice(0, META_FIELD_MAX)
  }
  return out
}

// ── Entry points ───────────────────────────────────────────────────────────

/** Read one optional part; a missing or unreadable part is just absent. */
function optionalPart(buffer: Buffer, entries: ZipEntry[], name: string): string | null {
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) return null
  try {
    return readEntry(buffer, entry).toString('utf-8')
  } catch {
    return null
  }
}

/**
 * Extract the body text (markdown-shaped: headings, lists, tables) and the core
 * metadata of a .docx buffer. Throws DocxExtractionError with a user-facing
 * message when the file is not a readable, unencrypted DOCX.
 */
export function extractDocx(buffer: Buffer, opts: { timeLimitMs?: number } = {}): { text: string; metadata: DocxMetadata } {
  const deadline = Date.now() + (opts.timeLimitMs ?? DOCX_EXTRACT_TIME_LIMIT_MS)
  if (buffer.length < 22) throw new DocxExtractionError('That .docx file is empty or truncated.')
  // Encrypted OOXML is an OLE compound file, not a ZIP — detect it by magic.
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
    throw new DocxExtractionError('That .docx is password-protected. Remove the password and upload it again.')
  }
  if (buffer.readUInt32LE(0) !== LOC_SIG && findEocd(buffer) < 0) {
    throw new DocxExtractionError('That file is not a readable .docx — its ZIP structure is missing or damaged.')
  }
  const entries = readCentralDirectory(buffer)
  const document = entries.find((entry) => entry.name === 'word/document.xml')
  if (!document) {
    throw new DocxExtractionError('That .docx has no document body (word/document.xml is missing) — re-save it from Word and try again.')
  }
  const xml = readEntry(buffer, document).toString('utf-8')
  if (!/<w:document[\s>]|<w:body[\s>]/.test(xml)) {
    throw new DocxExtractionError('That .docx document body could not be read — the file looks corrupt.')
  }
  const styles = optionalPart(buffer, entries, 'word/styles.xml')
  const core = optionalPart(buffer, entries, 'docProps/core.xml')
  return {
    text: documentXmlToText(xml, { headingStyles: styles ? headingStylesFromXml(styles) : undefined, deadline }),
    metadata: core ? coreMetadataFromXml(core) : {},
  }
}

/** Body text only — see {@link extractDocx}. */
export function extractDocxText(buffer: Buffer): string {
  return extractDocx(buffer).text
}
