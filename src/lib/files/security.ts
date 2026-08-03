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

/** Derive a trustworthy content type from magic bytes/content, not the browser. */
export function detectFileMime(buffer: Buffer, declared: string, filename: string): string {
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip'
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
    throw new Error('The uploaded file is named or labeled as a PDF but its contents are not a valid PDF.')
  }
  return detected
}

/** Optional malware-scanner hook. When required, absence/outage fails closed. */
export async function scanFileBuffer(buffer: Buffer, filename: string): Promise<void> {
  const url = process.env.FILE_SCAN_URL?.trim()
  const required = process.env.NODE_ENV === 'production' || process.env.FILE_SCAN_REQUIRED === 'true'
  if (!url) {
    if (required) throw new Error('File scanning is required but FILE_SCAN_URL is not configured.')
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
    if (!response.ok || result.clean !== true) throw new Error('The file did not pass malware scanning.')
  } catch (error) {
    if (required) throw error
    // Optional scanners may degrade without taking ordinary uploads down.
  }
}
