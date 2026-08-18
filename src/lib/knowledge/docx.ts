/**
 * DOCX → plain text, with no third-party parser: a .docx is a ZIP whose
 * `word/document.xml` holds the body in reading order. We read just that one
 * entry (central directory → local header → raw inflate via node:zlib) and walk
 * its XML for text runs, paragraph/line breaks, list markers, and table cells.
 *
 * Deliberately narrow: no styles, images, headers/footers, footnotes, or
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

/**
 * Walk `word/document.xml` in document order. WordprocessingML is a flat,
 * well-ordered tag stream for our purposes, so a tokenizing scan (rather than a
 * DOM) keeps this dependency-free and linear in the document size.
 *
 * Structure preserved: one line per paragraph, "- " in front of numbered/
 * bulleted paragraphs, tab-separated cells per table row, tabs and manual line
 * breaks inside a paragraph. Tracked deletions (<w:del>) are dropped.
 */
export function documentXmlToText(xml: string): string {
  const lines: string[] = []
  /** Table nesting: each level collects the current row's finished cells. */
  const rowStack: string[][] = []
  /** Paragraphs collected inside the innermost open <w:tc>. */
  const cellStack: string[][] = []
  let paragraph: string[] = []
  let paragraphIsListItem = false
  let inDeleted = 0
  let inText = false

  const flushParagraph = () => {
    const line = paragraph.join('').replace(/[ \t]+$/g, '')
    paragraph = []
    const marked = paragraphIsListItem && line.trim() ? `- ${line.replace(/^\s+/, '')}` : line
    paragraphIsListItem = false
    if (cellStack.length) cellStack[cellStack.length - 1].push(marked)
    else lines.push(marked)
  }

  const tagRe = /<[^>]*>/g
  let match: RegExpExecArray | null
  let cursor = 0
  while ((match = tagRe.exec(xml))) {
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
        if (!closing && !inDeleted) paragraph.push('\t')
        break
      case 'w:br':
      case 'w:cr':
        if (!closing && !inDeleted) paragraph.push('\n')
        break
      case 'w:numPr':
        if (!closing) paragraphIsListItem = true
        break
      case 'w:p':
        if (selfClosing) break
        if (closing) flushParagraph()
        else {
          paragraph = []
          paragraphIsListItem = false
        }
        break
      case 'w:tbl':
        if (selfClosing) break
        if (closing) rowStack.pop()
        else rowStack.push([])
        break
      case 'w:tr':
        if (selfClosing || !rowStack.length) break
        if (closing) {
          const cells = rowStack[rowStack.length - 1]
          const row = cells.join('\t').replace(/[\t ]+$/g, '')
          rowStack[rowStack.length - 1] = []
          if (row.trim()) lines.push(row)
        }
        break
      case 'w:tc':
        if (selfClosing) break
        if (closing) {
          const paragraphs = cellStack.pop() ?? []
          const cell = paragraphs.map((entry) => entry.trim()).filter(Boolean).join(' ')
          if (rowStack.length) rowStack[rowStack.length - 1].push(cell)
        } else {
          cellStack.push([])
        }
        break
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

/**
 * Extract the body text of a .docx buffer. Throws DocxExtractionError with a
 * user-facing message when the file is not a readable, unencrypted DOCX.
 */
export function extractDocxText(buffer: Buffer): string {
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
  return documentXmlToText(xml)
}
