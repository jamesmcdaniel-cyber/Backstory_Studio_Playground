/**
 * Turning a model's streamed output into the text a person should see as it
 * forms. Pure and client-safe; the routes feed deltas in and send what comes
 * out.
 */

/**
 * Reads one top-level string field (e.g. "reply", "message") out of a JSON
 * object while it is still being written, decoding escapes, and returns only
 * the characters that are new since the last call. Structured surfaces use it
 * to stream their human-readable field while the rest of the JSON (ops, a
 * proposal) arrives and is applied at the end.
 */
export function createJsonStringFieldReader(field: string): (delta: string) => string {
  let buffer = ''
  let emitted = 0
  const key = `"${field}"`
  return (delta: string) => {
    buffer += delta
    const keyAt = buffer.indexOf(key)
    if (keyAt < 0) return ''
    let i = keyAt + key.length
    while (i < buffer.length && /\s/.test(buffer[i])) i += 1
    if (buffer[i] !== ':') return ''
    i += 1
    while (i < buffer.length && /\s/.test(buffer[i])) i += 1
    if (buffer[i] !== '"') return ''
    i += 1
    let out = ''
    while (i < buffer.length) {
      const ch = buffer[i]
      if (ch === '"') break
      if (ch !== '\\') { out += ch; i += 1; continue }
      const next = buffer[i + 1]
      if (next === undefined) break // escape split across deltas: wait for more
      if (next === 'u') {
        const hex = buffer.slice(i + 2, i + 6)
        if (hex.length < 4) break
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === 'b' ? '\b' : next === 'f' ? '\f' : next
      i += 2
    }
    const fresh = out.slice(emitted)
    emitted = out.length
    return fresh
  }
}

/**
 * Streams free text but holds back a trailing control line (the Librarian's
 * `RELEVANT: 1, 3` citation line), so it never flashes on screen: text is
 * released only once it cannot be the start of that line.
 */
export function createTrailerFilter(marker = 'RELEVANT'): (delta: string) => string {
  let full = ''
  let emitted = 0
  let stopped = false
  return (delta: string) => {
    if (stopped) return ''
    full += delta
    const at = new RegExp(`(^|\\n)[ \\t]*${marker}[ \\t]*:`, 'i').exec(full)
    if (at) {
      stopped = true
      const safe = full.slice(0, at.index)
      const fresh = safe.slice(emitted)
      emitted = safe.length
      return fresh
    }
    // Hold the current line back only while it could still turn into the
    // marker line; any other text is released as soon as it arrives.
    const lineStart = full.lastIndexOf('\n') + 1
    const line = full.slice(lineStart).trimStart().toLowerCase()
    const couldBeMarker = line.length <= marker.length + 2 && `${marker.toLowerCase()}:`.startsWith(line.replace(/\s+/g, '').slice(0, marker.length + 1))
    const end = Math.max(emitted, couldBeMarker ? lineStart : full.length)
    const fresh = full.slice(emitted, end)
    emitted = end
    return fresh
  }
}
