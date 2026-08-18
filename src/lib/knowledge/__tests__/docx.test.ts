import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, crc32 } from 'node:zlib'
import { extractDocxText, documentXmlToText, isDocx, DocxExtractionError } from '../docx'
import { isSupported, extractText } from '../extract'

// ── A minimal, valid .docx built in memory (no binary fixture committed) ────

type Entry = { name: string; data: Buffer; store?: boolean }

function crc(buffer: Buffer): number {
  // node:zlib exposes crc32 on modern Node; fall back to a local table if not.
  if (typeof crc32 === 'function') return crc32(buffer) >>> 0
  let value = ~0
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  }
  return ~value >>> 0
}

/** Build a ZIP archive (deflate or stored) with the given entries. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8')
    const method = entry.store ? 0 : 8
    const payload = entry.store ? entry.data : deflateRawSync(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc(entry.data), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc(entry.data), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + payload.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}

const paragraph = (text: string, opts: { list?: boolean } = {}) =>
  `<w:p>${opts.list ? '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

const row = (cells: string[]) => `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
}

function docx(body: string, opts: { store?: boolean; omitDocument?: boolean } = {}): Buffer {
  const entries: Entry[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
  ]
  if (!opts.omitDocument) {
    entries.push({ name: 'word/document.xml', data: Buffer.from(documentXml(body), 'utf-8'), store: opts.store })
  }
  return zip(entries)
}

// ── Extraction ─────────────────────────────────────────────────────────────

test('extractDocxText reads paragraphs in reading order', () => {
  const buffer = docx(`${paragraph('Quarterly review')}${paragraph('Revenue grew 12%.')}${paragraph('')}${paragraph('Signed, Ada')}`)
  const text = extractDocxText(buffer)
  assert.equal(text, 'Quarterly review\nRevenue grew 12%.\n\nSigned, Ada')
})

test('extractDocxText marks list items and keeps tabs and manual line breaks', () => {
  const body =
    paragraph('Agenda') +
    paragraph('Budget', { list: true }) +
    paragraph('Hiring', { list: true }) +
    '<w:p><w:r><w:t>Left</w:t><w:tab/><w:t>Right</w:t><w:br/><w:t>Next line</w:t></w:r></w:p>'
  const text = extractDocxText(docx(body))
  assert.equal(text, 'Agenda\n- Budget\n- Hiring\nLeft\tRight\nNext line')
})

test('extractDocxText renders table cells as tab-separated rows', () => {
  const body = `<w:tbl>${row(['Region', 'Revenue'])}${row(['EMEA', '1,200'])}</w:tbl>${paragraph('After the table')}`
  const text = extractDocxText(docx(body))
  assert.equal(text, 'Region\tRevenue\nEMEA\t1,200\nAfter the table')
})

test('extractDocxText decodes entities and drops tracked deletions', () => {
  const body =
    '<w:p><w:r><w:t>Fish &amp; Chips &lt;5&#8364;&gt;</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText>Removed</w:delText></w:r></w:del></w:p>'
  const text = extractDocxText(docx(body))
  assert.equal(text, 'Fish & Chips <5€>\nKept')
})

test('extractDocxText reads a stored (uncompressed) document part', () => {
  const text = extractDocxText(docx(paragraph('Stored entry'), { store: true }))
  assert.equal(text, 'Stored entry')
})

// ── Clean rejections ───────────────────────────────────────────────────────

test('a non-zip buffer is rejected, never partially decoded', () => {
  assert.throws(
    () => extractDocxText(Buffer.from('this is plainly not a docx file at all, but long enough')),
    (error: unknown) => error instanceof DocxExtractionError && /not a readable \.docx/i.test((error as Error).message),
  )
})

test('a truncated docx is rejected', () => {
  const buffer = docx(paragraph('Hello'))
  assert.throws(() => extractDocxText(buffer.subarray(0, buffer.length - 40)), DocxExtractionError)
  assert.throws(() => extractDocxText(Buffer.alloc(4)), DocxExtractionError)
})

test('a docx whose document part is corrupt is rejected', () => {
  const buffer = docx(paragraph('Hello'))
  // Flip bytes inside the deflate stream — the local header stays intact so the
  // failure surfaces from decompression, not from the directory walk.
  const index = buffer.indexOf(Buffer.from('word/document.xml')) + 'word/document.xml'.length + 6
  buffer[index] ^= 0xff
  buffer[index + 1] ^= 0xff
  assert.throws(() => extractDocxText(buffer), DocxExtractionError)
})

test('a password-protected (OLE-container) docx is rejected by name', () => {
  const ole = Buffer.alloc(64)
  ole.writeUInt32BE(0xd0cf11e0, 0)
  assert.throws(
    () => extractDocxText(ole),
    (error: unknown) => error instanceof DocxExtractionError && /password-protected/i.test((error as Error).message),
  )
})

test('an encrypted zip entry is rejected by name', () => {
  const buffer = docx(paragraph('Secret'))
  // Set the "encrypted" general-purpose bit on the central-directory record.
  const central = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  buffer.writeUInt16LE(0x1, central + 8)
  assert.throws(
    () => extractDocxText(buffer),
    (error: unknown) => error instanceof DocxExtractionError && /password-protected/i.test((error as Error).message),
  )
})

test('a zip without word/document.xml is rejected', () => {
  assert.throws(
    () => extractDocxText(docx('', { omitDocument: true })),
    (error: unknown) => error instanceof DocxExtractionError && /document body/i.test((error as Error).message),
  )
})

test('a zip whose document.xml is not WordprocessingML is rejected', () => {
  const buffer = zip([{ name: 'word/document.xml', data: Buffer.from('<html><body>nope</body></html>') }])
  assert.throws(() => extractDocxText(buffer), DocxExtractionError)
})

// ── Wiring ─────────────────────────────────────────────────────────────────

test('isDocx and isSupported accept DOCX by mime type and extension', () => {
  assert.equal(isDocx('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x'), true)
  assert.equal(isDocx('', 'Report.DOCX'), true)
  assert.equal(isDocx('application/msword', 'legacy.doc'), false)
  assert.equal(isSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx'), true)
  assert.equal(isSupported('', 'notes.docx'), true)
  assert.equal(isSupported('image/png', 'logo.png'), false)
})

test('extractText routes DOCX bytes to the DOCX reader', () => {
  const buffer = docx(paragraph('Routed through extractText'))
  assert.equal(extractText(buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'Routed through extractText')
})

test('documentXmlToText tolerates an unterminated final paragraph', () => {
  assert.equal(documentXmlToText('<w:body><w:p><w:r><w:t>Tail</w:t></w:r>'), 'Tail')
})
