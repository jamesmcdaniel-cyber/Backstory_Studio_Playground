import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, crc32 } from 'node:zlib'
import { extractDocx, extractDocxText, documentXmlToText, isDocx, DocxExtractionError } from '../docx'
import { isSupported, extractText, extractDocumentAuto } from '../extract'
import { detectFileMime, verifyFileMime } from '@/lib/files/security'

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

function docx(body: string, opts: { store?: boolean; omitDocument?: boolean; styles?: string; core?: string } = {}): Buffer {
  const entries: Entry[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    { name: '_rels/.rels', data: Buffer.from('<Relationships/>') },
  ]
  if (!opts.omitDocument) {
    entries.push({ name: 'word/document.xml', data: Buffer.from(documentXml(body), 'utf-8'), store: opts.store })
  }
  if (opts.styles) entries.push({ name: 'word/styles.xml', data: Buffer.from(opts.styles, 'utf-8') })
  if (opts.core) entries.push({ name: 'docProps/core.xml', data: Buffer.from(opts.core, 'utf-8') })
  return zip(entries)
}

const styled = (style: string, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`

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

test('extractDocxText renders tables as markdown tables', () => {
  const body = `${paragraph('Before')}<w:tbl>${row(['Region', 'Revenue'])}${row(['EMEA', '1,200'])}${row(['A|B'])}</w:tbl>${paragraph('After the table')}`
  const text = extractDocxText(docx(body))
  assert.equal(text, 'Before\n\n| Region | Revenue |\n| --- | --- |\n| EMEA | 1,200 |\n| A\\|B |  |\n\nAfter the table')
})

test('a table nested in a cell is flattened into that cell', () => {
  const inner = `<w:tbl>${row(['x', 'y'])}${row(['z'])}</w:tbl>`
  const body = `<w:tbl>${row(['Key', 'Value'])}<w:tr><w:tc>${paragraph('Grid')}</w:tc><w:tc>${inner}</w:tc></w:tr></w:tbl>`
  assert.equal(extractDocxText(docx(body)), '| Key | Value |\n| --- | --- |\n| Grid | x / y; z |')
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

// ── Structure + metadata ───────────────────────────────────────────────────

test('headings come out as markdown headings, by built-in style id or outline level', () => {
  const body =
    styled('Title', 'Annual plan') +
    paragraph('Intro text') +
    styled('Heading2', 'Goals') +
    '<w:p><w:pPr><w:outlineLvl w:val="2"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Detail</w:t></w:r></w:p>' +
    paragraph('Body')
  assert.equal(extractDocxText(docx(body)), '# Annual plan\nIntro text\n\n## Goals\n\n### Detail\nBody')
})

test('localized heading style ids resolve through word/styles.xml', () => {
  const styles = `<w:styles>
    <w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>
    <w:style w:type="paragraph" w:styleId="Custom"><w:name w:val="My Section"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
    <w:style w:type="character" w:styleId="Strong"><w:name w:val="heading 3"/></w:style>
  </w:styles>`
  const body = styled('berschrift1', 'Einleitung') + styled('Custom', 'Abschnitt') + styled('Strong', 'Not a heading')
  assert.equal(extractDocxText(docx(body, { styles })), '# Einleitung\n\n## Abschnitt\nNot a heading')
})

test('core metadata is read from docProps/core.xml; a document without it has none', () => {
  const core = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z" xmlns:xsi="w">
    <dc:title>Q3 Board Memo</dc:title><dc:creator>Ada Lovelace</dc:creator><cp:keywords>board, q3</cp:keywords>
    <cp:lastModifiedBy>Grace</cp:lastModifiedBy><cp:revision>4</cp:revision>
    <dcterms:created xsi:type="dcterms:W3CDTF">2026-07-01T09:00:00Z</dcterms:created><dc:subject></dc:subject>
  </cp:coreProperties>`
  const { text, metadata } = extractDocx(docx(paragraph('Body'), { core }))
  assert.equal(text, 'Body')
  assert.deepEqual(metadata, {
    title: 'Q3 Board Memo', author: 'Ada Lovelace', keywords: 'board, q3', lastModifiedBy: 'Grace', revision: '4', created: '2026-07-01T09:00:00Z',
  })
  assert.deepEqual(extractDocx(docx(paragraph('Body'))).metadata, {})
})

test('extractDocumentAuto returns DOCX text with metadata, and omits metadata when there is none', async () => {
  const core = '<cp:coreProperties><dc:title>Plan</dc:title></cp:coreProperties>'
  const withMeta = await extractDocumentAuto(docx(styled('Heading1', 'Plan'), { core }), '', 'plan.docx')
  assert.deepEqual(withMeta, { text: '# Plan', metadata: { title: 'Plan' } })
  const plain = await extractDocumentAuto(Buffer.from('hello'), 'text/plain', 'a.txt')
  assert.deepEqual(plain, { text: 'hello' })
})

test('a walk past its time budget fails cleanly instead of pinning the worker', () => {
  const xml = `<w:body>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(2_000)}</w:body>`
  assert.throws(() => documentXmlToText(xml, { deadline: Date.now() - 1 }), (error: unknown) => error instanceof DocxExtractionError && /too long/.test((error as Error).message))
})

test('verifyFileMime stores a real DOCX as DOCX, a bare ZIP as zip, and never trusts a DOCX label on non-ZIP bytes', () => {
  const real = docx(paragraph('Hi'))
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  assert.equal(verifyFileMime(real, 'application/octet-stream', 'report.docx'), DOCX)
  assert.equal(detectFileMime(real, '', 'upload.bin'), DOCX, 'recognized by its entries even without a label')
  assert.equal(detectFileMime(zip([{ name: 'a.txt', data: Buffer.from('a') }]), '', 'a.zip'), 'application/zip')
  const ole = Buffer.alloc(64)
  ole.writeUInt32BE(0xd0cf11e0, 0)
  assert.notEqual(verifyFileMime(ole, DOCX, 'locked.docx'), DOCX)
})
