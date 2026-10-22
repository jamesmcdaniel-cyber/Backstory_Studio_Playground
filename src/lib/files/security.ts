/** A file the platform refuses to store; the message is safe to show the uploader. */
export class FileRejectedError extends Error {}

/**
 * Direct uploads may range-read only when scanning is optional and no scanner
 * exists. Required-but-unconfigured scanning must still read the whole object
 * so scanFileBuffer can reject it through the fail-closed policy.
 */
export function directUploadNeedsWholeFile(
  scannerUrl = process.env.FILE_SCAN_URL,
  scanRequired = process.env.FILE_SCAN_REQUIRED,
): boolean {
  return Boolean(scannerUrl) || scanRequired === 'true'
}

const TEXT_MIME = /^text\//i

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte)
}

function looksText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  if (buffer.length === 0) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  const decoded = sample.toString('utf8')
  const replacements = [...decoded].filter((char) => char === '\uFFFD').length
  return replacements / Math.max(1, decoded.length) < 0.01
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * A ZIP that is a Word document. Word writes `[Content_Types].xml` and
 * `word/...` entries whose names sit in the local headers at the front of the
 * archive, so the verification head (not just a whole buffer) can see them; a
 * ZIP the uploader labelled DOCX is taken at its word for the TYPE, and the
 * reader in lib/knowledge/docx.ts is what proves it is readable.
 */
function looksDocx(buffer: Buffer, declared: string, filename: string): boolean {
  if (/officedocument\.wordprocessingml\.(document|template)/i.test(declared) || /\.docx$/i.test(filename)) return true
  return buffer.includes('word/document.xml') || (buffer.includes('[Content_Types].xml') && buffer.includes('word/'))
}

/** Derive a trustworthy content type from magic bytes/content, not the browser. */
export function detectFileMime(buffer: Buffer, declared: string, filename: string): string {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return looksDocx(buffer, declared, filename) ? DOCX_MIME : 'application/zip'
  if (looksText(buffer)) {
    if (/\.jsonl?$/i.test(filename) || /^application\/json/i.test(declared)) return 'application/json'
    if (/\.csv$/i.test(filename) || /^application\/csv/i.test(declared)) return 'text/csv'
    if (/\.html?$/i.test(filename) || /html/i.test(declared)) return 'text/html'
    return TEXT_MIME.test(declared) ? declared.split(';')[0].trim().toLowerCase() : 'text/plain'
  }
  return 'application/octet-stream'
}

export function verifyFileMime(buffer: Buffer, declared: string, filename: string): string {
  const detected = detectFileMime(buffer, declared, filename)
  if ((/^application\/pdf/i.test(declared) || /\.pdf$/i.test(filename)) && detected !== 'application/pdf') {
    throw new FileRejectedError('The uploaded file is named or labeled as a PDF but its contents are not a valid PDF.')
  }
  // A DOCX label on something that is not a ZIP (a password-protected OLE
  // file, a truncated download) is NOT refused here, unlike a fake PDF: a flow
  // download's job is to keep the bytes, and the knowledge path already
  // rejects an unreadable DOCX by name (DocxExtractionError). It is simply
  // never stored AS a DOCX — the content-derived type wins, so nothing later
  // trusts the label over the bytes.
  return detected
}

/**
 * Executable formats never belong in a workspace's files: Windows PE, ELF,
 * Mach-O (both byte orders, 32/64-bit and universal). Checked on every
 * upload whether or not a scanner is configured — it needs only the head.
 */
const EXECUTABLE_SIGNATURES: number[][] = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
]

export function assertNotExecutable(buffer: Buffer): void {
  if (EXECUTABLE_SIGNATURES.some((signature) => startsWith(buffer, signature))) {
    throw new FileRejectedError('Executable files cannot be uploaded.')
  }
}

/**
 * Malware scanning. With FILE_SCAN_URL set, every untrusted upload is sent to
 * the scanner and anything it doesn't call clean is rejected. Without one,
 * the built-in checks (content-derived type, no executables) are the gate —
 * unless FILE_SCAN_REQUIRED=true, which makes a missing or failing scanner
 * reject uploads. Production used to imply "required", and with no scanner
 * deployed that turned every small upload into a 500.
 */
export async function scanFileBuffer(buffer: Buffer, filename: string): Promise<void> {
  assertNotExecutable(buffer)
  const url = process.env.FILE_SCAN_URL?.trim()
  const required = process.env.FILE_SCAN_REQUIRED === 'true'
  if (!url) {
    if (required) throw new FileRejectedError('Uploads are paused: file scanning is required but no scanner is configured.')
    return
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(filename).slice(0, 500) },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(20_000),
    })
    const result = await response.json().catch(() => ({})) as { clean?: boolean }
    if (response.ok && result.clean === false) throw new FileRejectedError('The file did not pass malware scanning.')
    if (!response.ok || result.clean !== true) throw new Error('The malware scanner did not return a result.')
  } catch (error) {
    // A scanner that says "infected" always rejects; one that is down only
    // rejects when scanning is required.
    if (error instanceof FileRejectedError || required) {
      throw error instanceof FileRejectedError ? error : new FileRejectedError('The malware scanner is unavailable; try again shortly.')
    }
  }
}
