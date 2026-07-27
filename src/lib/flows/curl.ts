// Parse a `curl` command into HTTP-node config. Pure and dependency-free so it
// can be unit-tested and run in the browser (the Import cURL dialog). Only the
// common flags are supported; unknown flags are ignored rather than rejected.

export type ParsedCurl = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'
  url?: string
  headers?: string // JSON object string, for the "Using JSON" header mode
  sendHeaders?: boolean
  body?: string
  bodyMode?: 'json' | 'raw' | 'form-urlencoded'
  sendBody?: boolean
  followRedirects?: boolean
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** Split a shell-ish command into tokens, honoring quotes and backslash line
 *  continuations. Not a full shell parser — enough for pasted curl commands. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1
        current += input[i]
      } else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && i + 1 < input.length && (input[i + 1] === '\n' || input[i + 1] === '\r')) {
      i += 1
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function contentTypeOf(headers: Record<string, string>): string {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type')
  return key ? headers[key].toLowerCase() : ''
}

export function parseCurl(command: string): ParsedCurl {
  const trimmed = command.trim().replace(/^\$\s+/, '')
  const tokens = tokenize(trimmed)
  if (tokens[0] === 'curl') tokens.shift()

  const result: ParsedCurl = {}
  const headers: Record<string, string> = {}
  const dataParts: string[] = []
  let method: ParsedCurl['method'] | undefined
  let hasData = false
  let dataUrlencoded = false

  const next = (i: number) => tokens[i + 1] ?? ''

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === '-X' || token === '--request') {
      const value = next(i).toUpperCase()
      if (METHODS.has(value)) method = value as ParsedCurl['method']
      i += 1
    } else if (token === '-H' || token === '--header') {
      const raw = next(i)
      const idx = raw.indexOf(':')
      if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
      i += 1
    } else if (token === '-A' || token === '--user-agent') {
      headers['User-Agent'] = next(i)
      i += 1
    } else if (token === '-e' || token === '--referer') {
      headers.Referer = next(i)
      i += 1
    } else if (token === '-b' || token === '--cookie') {
      headers.Cookie = next(i)
      i += 1
    } else if (token === '--data-urlencode') {
      dataParts.push(next(i))
      hasData = true
      dataUrlencoded = true
      i += 1
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-ascii') {
      dataParts.push(next(i))
      hasData = true
      i += 1
    } else if (token === '--json') {
      dataParts.push(next(i))
      hasData = true
      if (!contentTypeOf(headers)) headers['Content-Type'] = 'application/json'
      i += 1
    } else if (token === '-L' || token === '--location') {
      result.followRedirects = true
    } else if (token === '-G' || token === '--get') {
      method = 'GET'
    } else if (token === '--url') {
      result.url = next(i)
      i += 1
    } else if (token === '-u' || token === '--user' || token === '-o' || token === '--output') {
      // Skip the flag argument. -u basic-auth creds are intentionally not
      // written into the graph — set up a credential instead.
      i += 1
    } else if (!token.startsWith('-') && !result.url) {
      result.url = token
    }
  }

  if (method) result.method = method

  if (Object.keys(headers).length) {
    result.headers = JSON.stringify(headers, null, 2)
    result.sendHeaders = true
  }

  if (hasData) {
    const body = dataParts.join('&')
    result.body = body
    result.sendBody = true
    if (!result.method) result.method = 'POST'
    const contentType = contentTypeOf(headers)
    if (contentType.includes('json') || (/^\s*[[{]/.test(body) && !dataUrlencoded)) {
      result.bodyMode = 'json'
    } else if (contentType.includes('x-www-form-urlencoded') || dataUrlencoded || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
      result.bodyMode = 'form-urlencoded'
    } else {
      result.bodyMode = 'raw'
    }
  }

  return result
}
