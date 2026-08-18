/**
 * SSRF guard for user-provided outbound URLs (custom MCP server/token URLs).
 *
 * Requires https and resolves the host, rejecting any URL that points at a
 * loopback/private/link-local/reserved address — including the cloud metadata
 * endpoint (169.254.169.254). Applied both when a URL is saved and again before
 * each fetch, so a host that later resolves to a private IP is still blocked.
 *
 * ── DNS rebinding ────────────────────────────────────────────────────────
 * Validating and then fetching used to be two independent resolutions: the
 * guard saw a public address, the socket asked DNS again a millisecond later,
 * and an attacker-controlled zone with a 0-second TTL answered the SECOND
 * question with 169.254.169.254. Re-resolving narrowed that window; it never
 * closed it, because the connection was never told what the guard had approved.
 *
 * `assertPublicUrl` now PINS what it validated: the approved addresses are
 * recorded for the hostname, and a `dns.lookup` interceptor serves exactly
 * those addresses to the connecting socket for the life of the pin. The socket
 * therefore connects to an address the guard actually saw and approved, while
 * the URL — and so the Host header and the TLS SNI/certificate check — still
 * carries the hostname, so nothing about the request or its trust chain
 * changes. Hostnames that were never validated resolve normally; the
 * interceptor only ever narrows, never widens.
 *
 * Redirects are re-validated and re-pinned per hop by `fetchPublicUrl` — a 302
 * to an internal host is a fresh URL and gets a fresh guard pass.
 */

import dns from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfError'
  }
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    n = n * 256 + octet
  }
  return n >>> 0
}

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToLong(ip)
  if (n === null) return true
  const inRange = (base: string, bits: number) => {
    const b = ipv4ToLong(base)
    if (b === null) return false
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (b & mask)
  }
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // RFC1918 private
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
    inRange('172.16.0.0', 12) ||    // RFC1918 private
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.168.0.0', 16) ||   // RFC1918 private
    inRange('198.18.0.0', 15) ||    // benchmarking
    n >= (ipv4ToLong('224.0.0.0') as number) // multicast + reserved
  )
}

// Extract the embedded IPv4 from an IPv4-mapped/compatible IPv6, in EITHER the
// dotted form (::ffff:1.2.3.4) or the hex form the WHATWG URL parser produces
// (::ffff:7f00:1). Without the hex case, mapped literals for loopback/metadata
// slip past the guard.
function mappedIPv4(a: string): string | null {
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const hex = a.match(/^::(?:ffff:)?(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

function isBlockedIPv6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (a === '::1' || a === '::') return true
  if (/^fe[89ab]/.test(a)) return true // link-local fe80::/10
  if (a.startsWith('fc') || a.startsWith('fd')) return true // unique-local fc00::/7
  const mapped = mappedIPv4(a)
  if (mapped) return isBlockedIPv4(mapped)
  return false
}

function isBlockedIp(ip: string): boolean {
  const version = isIP(ip)
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return true // not a parseable IP → block
}

// ── Resolve-then-pin ───────────────────────────────────────────────────────

/** One validated answer: the address and the family the socket must ask for. */
export interface PinnedAddress {
  address: string
  family: 4 | 6
}

type Resolver = (host: string) => Promise<PinnedAddress[]>

const systemResolver: Resolver = async (host) => {
  const answers = await lookup(host, { all: true })
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }))
}

let resolver: Resolver = systemResolver

/**
 * Test seam: swap the resolver so rebinding can be simulated deterministically
 * (a first answer that is public, a second that is not). Passing null restores
 * the system resolver. Not used by production code.
 */
export function __setSsrfResolver(next: Resolver | null): void {
  resolver = next ?? systemResolver
}

/**
 * How long a validated answer stays pinned. Long enough to cover the fetch the
 * guard was called for (including a slow TLS handshake and a connection reused
 * by a keep-alive pool), short enough that a legitimate DNS change is picked up
 * on the next guarded call rather than being frozen into the process.
 */
const PIN_TTL_MS = 60_000

interface Pin {
  addresses: PinnedAddress[]
  expiresAt: number
}

const pins = new Map<string, Pin>()

function pinKey(host: string): string {
  return host.toLowerCase()
}

function livePin(host: string, now = Date.now()): Pin | null {
  const pin = pins.get(pinKey(host))
  if (!pin) return null
  if (pin.expiresAt <= now) {
    pins.delete(pinKey(host))
    return null
  }
  return pin
}

/** The addresses currently pinned for a host (empty when nothing is pinned). */
export function pinnedAddresses(host: string): PinnedAddress[] {
  return livePin(host)?.addresses.slice() ?? []
}

/** Drop every pin — test hygiene, and a manual escape hatch. */
export function clearPins(): void {
  pins.clear()
}

function pin(host: string, addresses: PinnedAddress[]): void {
  if (addresses.length === 0) return
  pins.set(pinKey(host), { addresses, expiresAt: Date.now() + PIN_TTL_MS })
  // Opportunistic sweep so a long-lived worker doesn't accumulate dead pins.
  if (pins.size > 2_000) {
    const now = Date.now()
    for (const [key, entry] of pins) if (entry.expiresAt <= now) pins.delete(key)
  }
  installLookupInterceptor()
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | PinnedAddress[],
  family?: number,
) => void

/**
 * The answer the interceptor hands the socket, or null when this hostname has
 * no live pin (in which case the real resolver runs, unchanged).
 *
 * Exported for the tests: the interceptor itself is installed on a global, and
 * asserting on this function is how the pin is verified without opening a
 * socket.
 */
export function pinnedLookupAnswer(
  host: string,
  options: { all?: boolean; family?: number },
): PinnedAddress[] | null {
  const entry = livePin(host)
  if (!entry) return null
  const wanted = options.family === 4 || options.family === 6 ? options.family : 0
  const matching = wanted ? entry.addresses.filter((a) => a.family === wanted) : entry.addresses
  // A pin that cannot satisfy the requested family must NOT fall through to the
  // real resolver — that is exactly the rebinding hole. Report "no address".
  if (matching.length === 0) return []
  return options.all ? matching : [matching[0]]
}

let interceptorInstalled = false

/**
 * Replace `dns.lookup` with a wrapper that serves pinned answers. `net.connect`
 * — and therefore undici, and therefore global `fetch` — resolves through this
 * function, so this is the seam where a validated address becomes the address
 * actually dialled. Everything unpinned is delegated untouched.
 */
function installLookupInterceptor(): void {
  if (interceptorInstalled) return
  interceptorInstalled = true
  const original = dns.lookup

  const patched = function patchedLookup(
    this: unknown,
    hostname: string,
    options: unknown,
    callback?: unknown,
  ) {
    const done = (typeof options === 'function' ? options : callback) as LookupCallback | undefined
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: number }
    const numericFamily = typeof options === 'number' ? options : undefined
    if (typeof done !== 'function' || typeof hostname !== 'string' || !hostname) {
      return (original as unknown as (...args: unknown[]) => unknown).call(this, hostname, options, callback)
    }
    const answer = pinnedLookupAnswer(hostname, {
      all: Boolean(opts.all),
      family: numericFamily ?? opts.family,
    })
    if (answer === null) {
      return (original as unknown as (...args: unknown[]) => unknown).call(this, hostname, options, callback)
    }
    if (answer.length === 0) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
      error.code = 'ENOTFOUND'
      return process.nextTick(() => done(error))
    }
    if (opts.all) return process.nextTick(() => done(null, answer))
    return process.nextTick(() => done(null, answer[0].address, answer[0].family))
  }

  // Node's `net` reads `dns.lookup` off the module object at call time, so this
  // assignment is what the socket picks up. `__promisify__` is carried over so
  // `dns/promises` and util.promisify keep working.
  const carried = (original as unknown as Record<string, unknown>)['__promisify__']
  if (carried) (patched as unknown as Record<string, unknown>)['__promisify__'] = carried
  ;(dns as unknown as Record<string, unknown>).lookup = patched
}

/**
 * Throws SsrfError unless `raw` is an https URL whose host resolves ONLY to
 * public addresses. Safe to call on every request and on save.
 *
 * On success the validated addresses are pinned for the hostname (see the DNS
 * rebinding note at the top of this file), so the connection that follows dials
 * an address this guard approved rather than re-asking a hostile resolver.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('Invalid URL')
  }
  if (url.protocol !== 'https:') throw new SsrfError('Only https URLs are allowed')

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    // An IP literal is already pinned by construction — there is nothing to
    // resolve and so no window to close.
    if (isBlockedIp(host)) throw new SsrfError('URL host is a private or reserved address')
    return
  }

  let addresses: PinnedAddress[]
  try {
    addresses = await resolver(host)
  } catch {
    throw new SsrfError('Could not resolve URL host')
  }
  if (addresses.length === 0) throw new SsrfError('URL host did not resolve')
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new SsrfError('URL resolves to a private or reserved address')
  }
  pin(host, addresses)
}

/** Redirect statuses that carry a Location we would otherwise follow blindly. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface FetchPublicUrlOptions {
  /** Hops to follow. 0 makes a redirect an error, matching `redirect: 'error'`. */
  maxRedirects?: number
  /** Test seam; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * `fetch` for attacker-influenced URLs: every hop is guarded and pinned before
 * it is dialled, including each redirect target.
 *
 * `redirect: 'manual'` is deliberate — letting the platform follow the chain
 * would send hops 2..n out with no guard at all, which is the classic
 * "validated URL redirects to 169.254.169.254" bypass.
 */
export async function fetchPublicUrl(
  input: string,
  init: RequestInit = {},
  options: FetchPublicUrlOptions = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const maxRedirects = options.maxRedirects ?? 5
  let target = input
  let body = init.body

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(target)
    const response = await doFetch(target, { ...init, body, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response

    const location = response.headers.get('location')
    if (!location) return response
    if (hop >= maxRedirects) {
      throw new SsrfError(
        maxRedirects === 0 ? 'Redirects are not allowed for this request' : 'Too many redirects',
      )
    }
    let next: URL
    try {
      next = new URL(location, target)
    } catch {
      throw new SsrfError('Redirect target is not a valid URL')
    }
    // 303 (and, by universal practice, 301/302 after a POST) drops the body and
    // becomes a GET; a body cannot be replayed to a new host regardless.
    if (response.status === 303) body = undefined
    target = next.toString()
  }
}
