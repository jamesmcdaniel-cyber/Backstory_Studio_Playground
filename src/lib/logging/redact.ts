/**
 * Structural redaction for log metadata.
 *
 * Before this existed, `apiLogger` was an 11-line `console.*` wrapper and
 * secrets stayed out of logs purely by convention — every call site had to
 * remember not to pass a credential. That held only as long as nobody wrote
 * `apiLogger.error('refresh failed', { cfg })`, which is the natural thing to
 * write while debugging a token refresh and would have printed a decrypted
 * refresh token to the platform log.
 *
 * Two independent defences, because either alone has a blind spot:
 *
 *   1. KEY NAME — anything called `accessToken`, `apiKey`, `password`… goes,
 *      whatever it holds. Catches short or oddly-shaped secrets no pattern
 *      would recognise.
 *   2. VALUE SHAPE — Bearer headers, JWTs, known vendor prefixes and our own
 *      `v1:`/`v2:`/`b64:` envelopes go even under an innocent key like
 *      `detail` or `payload`, which is how secrets usually reach a log line.
 *
 * Deliberately NOT entropy-based: high-entropy strings are also cuids, hashes,
 * org ids and run ids — the things you actually need in a log. A redactor that
 * eats those gets turned off, which is worse than no redactor.
 */

export const REDACTED = '[REDACTED]'

// ── Key-name rules ─────────────────────────────────────────────────────────

/**
 * Substrings that make a key's value a secret. Matched against the key with
 * separators stripped, so `access_token`, `access-token` and `accessToken` are
 * one rule.
 */
const SECRET_KEY_PARTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'credential',
  'cookie',
  'privatekey',
  'accesskey',
  'sessionid',
  'signature',
  'passphrase',
]

/**
 * Keys that contain a secret substring but hold nothing secret. `tokenUrl` and
 * `tokenEndpoint` are the endpoints we POST to — losing them makes an OAuth
 * failure much harder to read, and they are published in provider metadata
 * anyway.
 */
const NON_SECRET_KEYS = new Set([
  'tokenurl',
  'tokenendpoint',
  'tokentype',
  'tokenizer',
  'keyid',
  'payloadhash',
  'signaturevalid',
  'hastoken',
  'hasapikey',
  'hasclientsecret',
  'hasrefreshtoken',
])

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-.\s]/g, '')
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (NON_SECRET_KEYS.has(normalized)) return false
  return SECRET_KEY_PARTS.some((part) => normalized.includes(part))
}

// ── Value-shape rules ──────────────────────────────────────────────────────

/**
 * Our own storage envelopes. Anchored, so the whole value goes: a ciphertext in
 * a log is both a credential to attack offline and a disclosure of which
 * encryption key the deployment is currently writing with.
 */
const ENVELOPE_RE = /^(?:v1|v2|b64):/

/** A whole-value JWT — three base64url segments. */
const JWT_RE = /\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g

/** `Authorization: Bearer …` / `Basic …`, wherever it appears in a string. */
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token|DPoP)\s+[A-Za-z0-9._~+/=-]{8,}/gi

/**
 * Vendor key prefixes. These are advertised, stable and unambiguous — a string
 * starting `sk-ant-` or `xoxb-` is a live credential and nothing else.
 */
const VENDOR_TOKEN_RE = new RegExp(
  [
    'sk-ant-[A-Za-z0-9_-]{8,}',
    'sk-[A-Za-z0-9]{16,}',
    'gh[pousr]_[A-Za-z0-9]{16,}',
    'github_pat_[A-Za-z0-9_]{16,}',
    'xox[baprs]-[A-Za-z0-9-]{8,}',
    'mcp_[A-Za-z0-9_-]{8,}',
    'glpat-[A-Za-z0-9_-]{8,}',
    'npm_[A-Za-z0-9]{16,}',
    'shpat_[A-Za-z0-9]{16,}',
    'AKIA[0-9A-Z]{12,}',
    'ASIA[0-9A-Z]{12,}',
    'AIza[A-Za-z0-9_-]{16,}',
    'ya29\\.[A-Za-z0-9_-]{16,}',
    '(?:pk|sk)_(?:live|test)_[A-Za-z0-9]{16,}',
    'nango_[A-Za-z0-9_-]{8,}',
  ].join('|'),
  'g',
)

/** Query parameters whose value is a credential. */
const SECRET_QUERY_PARAM_RE =
  /([?&])((?:[a-z0-9_-]*)?(?:api_?key|access_?token|refresh_?token|id_?token|token|secret|password|passwd|signature|sig|auth|code|state)(?:[a-z0-9_-]*)?)=([^&#\s]*)/gi

/** Credentials embedded in a URL's userinfo section (`https://user:pw@host`). */
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

/**
 * Strip credentials out of a URL while keeping host and path.
 *
 * The host and path are the whole point of logging a URL — "which endpoint did
 * we call" is the first question during an integration failure — so this is
 * surgery on the original string rather than a reserialised `URL`, which would
 * percent-encode the marker and reorder the query.
 */
function redactUrl(value: string): string {
  return value
    .replace(URL_USERINFO_RE, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(SECRET_QUERY_PARAM_RE, (_match, sep: string, param: string) => `${sep}${param}=${REDACTED}`)
}

/**
 * Redact any credential visible in a string.
 *
 * Embedded matches are cut out in place rather than taking the whole value:
 * `token refresh failed for Bearer sk-…` should still say what failed. When the
 * removal leaves nothing but the marker and an auth-scheme keyword, the string
 * WAS the credential, so it collapses to the bare marker.
 */
export function redactString(value: string): string {
  if (ENVELOPE_RE.test(value)) return REDACTED

  let out = value
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(VENDOR_TOKEN_RE, REDACTED)

  if (looksLikeUrl(out)) out = redactUrl(out)

  const residue = out.replaceAll(REDACTED, '').replace(/\b(Bearer|Basic|Token|DPoP)\b/gi, '').trim()
  return residue.length === 0 && out !== value ? REDACTED : out
}

// ── Walker ─────────────────────────────────────────────────────────────────

const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50
const MAX_OBJECT_KEYS = 100

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value

  // Numbers and booleans are never secrets, and exempting them is what keeps
  // `inputTokens: 500` / `maxTokens: 4096` readable despite matching a key rule.
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value

  if (typeof value === 'string') return redactString(value)

  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    }
  }

  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `[Buffer ${value.byteLength}B]`

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return '[MaxDepth]'
    seen.add(value)

    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1, seen))
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`)
      return items
    }

    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1, seen)
    }
    return out
  }

  return value
}

/**
 * Redact a log `meta` object. Never throws: a redactor that can crash the
 * logger would take down the code path it was meant to make safe, so an
 * unexpected shape degrades to a marker instead.
 */
export function redactLogMeta(meta: unknown): unknown {
  try {
    return redactValue(meta, 0, new WeakSet())
  } catch {
    return '[unloggable]'
  }
}
