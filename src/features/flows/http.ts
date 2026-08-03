import { readResponseTextLimited } from '@/lib/net/response-body'

export type FlowHttpConfig = {
  credentialId?: unknown
  connectionId?: unknown
  method?: unknown
  url?: unknown
  query?: unknown
  headers?: unknown
  body?: unknown
  sendQuery?: unknown
  sendHeaders?: unknown
  sendBody?: unknown
  bodyMode?: unknown
  contentType?: unknown
  responseType?: unknown
  followRedirects?: unknown
  maxRedirects?: unknown
  failOnHttpError?: unknown
  retries?: unknown
  timeoutMs?: unknown
  cookie?: unknown
}

export type FlowHttpOutput = {
  ok: boolean
  status: number
  statusText: string
  url: string
  headers: Record<string, string>
  // The parsed response (object/array) when JSON, else the response text. This
  // is the data downstream steps consume — reachable as `.body`, or the `.data`
  // read-time alias (see readPath's http-envelope handling), so structure
  // survives responses larger than the display cap.
  body: unknown
  // The raw response text, truncated for display/persistence.
  bodyText: string
}

// Parse JSON from up to this many chars of the response. Generous so real
// query-API payloads stay fully structured, bounded so a pathological response
// can't persist an unbounded object on the run row.
const PARSE_MAX_CHARS = 400_000
const RESPONSE_MAX_BYTES = 1_000_000

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const JSON_RE = /^(?:\{|\[|true|false|null|-?\d|")/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseObjectInput(value: unknown, label: string): Record<string, unknown> {
  if (value == null || value === '') return {}
  if (isRecord(value)) return value
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON object.`)
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    /* throw below */
  }
  throw new Error(`${label} must be a JSON object.`)
}

function stringifyHeaderValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function headersFrom(value: unknown): Record<string, string> {
  const parsed = parseObjectInput(value, 'Headers')
  return Object.fromEntries(
    Object.entries(parsed)
      .map(([key, item]) => [key, stringifyHeaderValue(item)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0].trim()) && entry[1] !== undefined),
  )
}

function queryUrl(url: string, query: unknown): string {
  const params = parseObjectInput(query, 'Query params')
  if (!Object.keys(params).length) return url
  const next = new URL(url)
  for (const [key, value] of Object.entries(params)) {
    if (!key.trim() || value == null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null && item !== '') next.searchParams.append(key, String(item))
      }
      continue
    }
    next.searchParams.set(key, String(value))
  }
  return next.toString()
}

type BodyMode = 'json' | 'raw' | 'graphql' | 'form-urlencoded' | 'form-data' | 'none'

function explicitBodyMode(value: unknown): BodyMode | undefined {
  if (value === 'text') return 'raw'
  return value === 'json' || value === 'raw' || value === 'graphql' || value === 'form-urlencoded' || value === 'form-data' || value === 'none'
    ? value
    : undefined
}

function inferBodyMode(body: unknown): BodyMode {
  if (body == null || body === '') return 'none'
  if (typeof body !== 'string') return 'json'
  return JSON_RE.test(body.trim()) ? 'json' : 'raw'
}

function jsonBody(body: unknown): string | undefined {
  if (body == null || body === '') return undefined
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (!trimmed) return undefined
    try {
      return JSON.stringify(JSON.parse(trimmed))
    } catch {
      throw new Error('HTTP body is not valid JSON after template substitution.')
    }
  }
  return JSON.stringify(body)
}

function textBody(body: unknown): string | undefined {
  if (body == null) return undefined
  return typeof body === 'string' ? body : JSON.stringify(body)
}

function formBody(body: unknown): string | undefined {
  const parsed = parseObjectInput(body, 'Form URL encoded body')
  if (!Object.keys(parsed).length) return undefined
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, String(item))
    } else if (value != null) {
      form.set(key, String(value))
    }
  }
  return form.toString()
}

// Multipart form-data of text fields. Returns a FormData so the fetch runtime
// sets the multipart content-type + boundary itself — we must NOT set one by
// hand. FILE fields (values that are file references) are handled in the HTTP
// adapter (execute-flow), which reads the StoredFile bytes and rebuilds the
// FormData with real Blobs — this pure path can't read from the DB, so it
// stringifies a file reference; the adapter overrides that when files are present.
function formDataBody(body: unknown): FormData | undefined {
  const parsed = parseObjectInput(body, 'Form-data body')
  const entries = Object.entries(parsed)
  if (!entries.length) return undefined
  const form = new FormData()
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const item of value) if (item != null) form.append(key, String(item))
    } else if (value != null) {
      form.append(key, String(value))
    }
  }
  return form
}

function graphqlBody(body: unknown): string | undefined {
  if (body == null || body === '') return undefined
  if (typeof body !== 'string') return JSON.stringify(body)
  const trimmed = body.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return JSON.stringify(parsed)
  } catch {
    return JSON.stringify({ query: body })
  }
}

export function prepareHttpRequest(config: FlowHttpConfig): { url: string; init: RequestInit; timeoutMs: number; failOnHttpError: boolean; responseType: 'auto' | 'json' | 'text'; followRedirects: boolean; maxRedirects?: number } {
  const method = String(config.method || 'POST').toUpperCase()
  const url = queryUrl(String(config.url || ''), config.sendQuery === false ? undefined : config.query)
  const headers = headersFrom(config.sendHeaders === false ? undefined : config.headers)
  // The Cookie field is a convenience for the common single-header case; an
  // explicit Cookie among `headers` always wins.
  if (typeof config.cookie === 'string' && config.cookie.trim() !== '' && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
    headers.cookie = config.cookie
  }
  const mode = explicitBodyMode(config.bodyMode) ?? inferBodyMode(config.body)
  const bodyAllowed = BODY_METHODS.has(method)
  let body: string | FormData | undefined
  if (bodyAllowed && config.sendBody !== false && mode !== 'none') {
    body =
      mode === 'json'
        ? jsonBody(config.body)
        : mode === 'form-urlencoded'
          ? formBody(config.body)
          : mode === 'form-data'
            ? formDataBody(config.body)
            : mode === 'graphql'
              ? graphqlBody(config.body)
              : textBody(config.body)
    // form-data must leave content-type unset so the runtime can add the
    // multipart boundary; only string bodies get an explicit content-type.
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
    if (body && typeof body === 'string' && !hasContentType) {
      if (mode === 'json' || mode === 'graphql') headers['content-type'] = 'application/json'
      else if (mode === 'form-urlencoded') headers['content-type'] = 'application/x-www-form-urlencoded'
      else if (typeof config.contentType === 'string' && config.contentType.trim()) headers['content-type'] = config.contentType.trim()
    }
  }
  const timeoutMs = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs)
    ? Math.max(1000, Math.min(120000, Math.round(config.timeoutMs)))
    : 30_000
  const responseType = config.responseType === 'json' || config.responseType === 'text' ? config.responseType : 'auto'
  const followRedirects = config.followRedirects === true
  return {
    url,
    // 'manual' lets fetchWithHttpCredential inspect each hop and re-run the SSRF
    // guard before following; 'error' refuses redirects outright otherwise.
    init: { method, headers, ...(body !== undefined ? { body } : {}), redirect: followRedirects ? 'manual' : 'error' },
    timeoutMs,
    failOnHttpError: config.failOnHttpError !== false,
    responseType,
    followRedirects,
    ...(typeof config.maxRedirects === 'number' && Number.isInteger(config.maxRedirects) && config.maxRedirects >= 0
      ? { maxRedirects: config.maxRedirects }
      : {}),
  }
}

// ── Connection auth: pure header helpers ────────────────────────────────────
// Injection happens server-side at fetch time only; the token never enters the
// graph JSON or persisted step rows. Redaction covers the user-supplied case.

const AUTH_HEADER_RE = /^(authorization|proxy-authorization)$/i

// Header keys are trimmed to match redactAuthHeaders; values that are empty or
// whitespace-only (e.g. a template that resolved to '') don't count as an
// explicit auth header — they must not block injection or be sent blank.
const hasAuthHeader = (headers: Record<string, string>) =>
  Object.entries(headers).some(([key, value]) => AUTH_HEADER_RE.test(key.trim()) && value.trim() !== '')

/**
 * Add `authorization: Bearer <token>` unless the request already carries a
 * non-empty Authorization header — an explicit user-supplied header always
 * wins. Empty/whitespace-only Authorization values are treated as absent and
 * dropped so the request never carries a blank credential next to the
 * injected one.
 */
export function withBearerAuthorization(headers: Record<string, string>, token: string): Record<string, string> {
  if (hasAuthHeader(headers)) return headers
  const rest = Object.entries(headers).filter(([key]) => !AUTH_HEADER_RE.test(key.trim()))
  return { ...Object.fromEntries(rest), authorization: `Bearer ${token}` }
}

/**
 * Replace the value of any Authorization-like header with 'redacted' so
 * persisted request details (FlowRunStep.input) never contain credentials.
 * Accepts the shapes an http step's `headers` config can hold: a parsed
 * object, a JSON string, or an arbitrary string.
 */
export function redactAuthHeaders(headers: unknown): unknown {
  if (isRecord(headers)) {
    return Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, AUTH_HEADER_RE.test(key.trim()) ? 'redacted' : value]),
    )
  }
  if (typeof headers === 'string') {
    try {
      const parsed = JSON.parse(headers)
      if (isRecord(parsed)) return JSON.stringify(redactAuthHeaders(parsed))
    } catch {
      /* fall through */
    }
    // Not a JSON object — if it mentions an auth header at all, drop the whole
    // string rather than risk persisting a credential.
    return /authorization/i.test(headers) ? 'redacted' : headers
  }
  return headers
}

/** An http step's config as safe to persist: auth header values redacted. */
export function redactHttpStepInput(config: Record<string, unknown>): Record<string, unknown> {
  if (config.headers === undefined || config.headers === null) return config
  return { ...config, headers: redactAuthHeaders(config.headers) }
}

function shouldParseJson(contentType: string, responseType: 'auto' | 'json' | 'text', text: string) {
  if (responseType === 'text') return false
  if (responseType === 'json') return true
  return contentType.toLowerCase().includes('json') || JSON_RE.test(text.trim())
}

export async function responseOutput(response: Response, responseType: 'auto' | 'json' | 'text', maxChars = 50_000): Promise<FlowHttpOutput> {
  // Read a bounded body, then parse JSON from it BEFORE display truncation.
  // Truncating first (the old behavior) silently de-structured any JSON larger than
  // maxChars into an invalid, truncated string — so `{{...output.body.field}}`
  // returned undefined with no error. Parsing the whole payload keeps large
  // API responses fully structured; only the raw-text mirror (`bodyText`) is
  // capped, for display/persistence.
  const raw = await readResponseTextLimited(response, RESPONSE_MAX_BYTES, 'HTTP response')
  const headers = Object.fromEntries(response.headers.entries())
  const bodyText = raw.slice(0, maxChars)
  const parseSource = raw.length > PARSE_MAX_CHARS ? raw.slice(0, PARSE_MAX_CHARS) : raw
  let body: unknown = bodyText
  if (parseSource && shouldParseJson(headers['content-type'] ?? '', responseType, parseSource)) {
    try {
      body = JSON.parse(parseSource)
    } catch {
      if (responseType === 'json') throw new Error('HTTP response was not valid JSON.')
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    body,
    bodyText,
  }
}
