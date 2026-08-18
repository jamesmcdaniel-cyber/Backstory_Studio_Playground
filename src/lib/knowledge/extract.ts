/**
 * Text extraction + chunking for uploaded knowledge files: text-based formats
 * (plain text, markdown, csv/tsv, json, yaml, xml, html, common source code)
 * decode directly; PDFs extract via unpdf (pure-JS pdf.js build, serverless-
 * safe); DOCX goes through the dependency-free reader in ./docx (ZIP entry +
 * WordprocessingML walk), which rejects corrupt/encrypted files outright.
 */

import { extractDocxText, isDocx } from './docx'

const CODE_EXT =
  /\.(md|markdown|txt|text|csv|tsv|json|jsonl|ya?ml|xml|html?|log|js|ts|tsx|jsx|py|rb|go|java|kt|c|cc|cpp|h|hpp|cs|php|rs|swift|sh|bash|sql|css|scss|less|toml|ini|env)$/i

function isPdf(mimeType: string, filename: string): boolean {
  return /^application\/pdf/i.test(mimeType) || /\.pdf$/i.test(filename)
}

/** Whether a file can be extracted to text. */
export function isSupported(mimeType: string, filename: string): boolean {
  if (isPdf(mimeType, filename)) return true
  if (isDocx(mimeType, filename)) return true
  if (/^text\//i.test(mimeType)) return true
  if (/^application\/(json|xml|csv|markdown|x-yaml|yaml|xhtml\+xml|javascript|sql)/i.test(mimeType)) return true
  return CODE_EXT.test(filename)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
}

const NULL_CHAR = String.fromCharCode(0)

/**
 * Decode a file's bytes to normalized text. PDFs go through unpdf (async);
 * everything else is the synchronous decode below.
 */
export async function extractTextAuto(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  if (isPdf(mimeType, filename)) {
    const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractPdfText(pdf, { mergePages: true })
    return text.split(NULL_CHAR).join('').replace(/\r\n/g, '\n').trim()
  }
  return extractText(buffer, mimeType, filename)
}

/** Decode a file's bytes to normalized text (stripping HTML markup when present). */
export function extractText(buffer: Buffer, mimeType: string, filename: string): string {
  // DOCX is binary, so it never goes through the utf-8 decode below. A corrupt
  // or password-protected file throws DocxExtractionError rather than returning
  // the mojibake a raw decode would produce.
  if (isDocx(mimeType, filename)) return extractDocxText(buffer)
  let text = buffer.toString('utf-8')
  if (/html/i.test(mimeType) || /\.html?$/i.test(filename)) text = stripHtml(text)
  return text.split(NULL_CHAR).join('').replace(/\r\n/g, '\n').trim()
}

/**
 * Split text into overlapping chunks, preferring paragraph/sentence boundaries
 * within each window so a chunk doesn't cut mid-thought.
 */
export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? 1200
  const overlap = opts.overlap ?? 150
  const clean = text.trim()
  if (!clean) return []
  if (clean.length <= size) return [clean]

  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
      if (boundary > size * 0.5) end = start + boundary + 1
    }
    const piece = clean.slice(start, end).trim()
    if (piece) chunks.push(piece)
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}
