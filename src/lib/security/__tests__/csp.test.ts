import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { buildContentSecurityPolicy, cspHeaderName } from '../csp'

/**
 * Pins the CSP entries whose absence breaks a whole product surface SILENTLY —
 * the page renders, one embedded thing shows "This content is blocked", and
 * the report lands in a console nobody is watching. The Nango Connect iframe
 * was exactly that: the strict-CSP rollout omitted connect.nango.dev from
 * frame-src and every OAuth integration connect died in production.
 */

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function frameSrcOf(csp: string): string {
  const directive = csp.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('frame-src'))
  assert.ok(directive, 'the policy must carry a frame-src directive')
  return directive
}

test('frame-src admits the Nango Connect UI — every OAuth integration connects through it', () => {
  delete process.env.NEXT_PUBLIC_NANGO_CONNECT_URL
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })

  assert.ok(
    frameSrcOf(csp).includes('https://connect.nango.dev'),
    'connect.nango.dev missing from frame-src — this is the outage where every integration shows "This content is blocked"',
  )
})

test('a self-hosted Connect UI override is reflected in frame-src', () => {
  // The client passes NEXT_PUBLIC_NANGO_CONNECT_URL as the iframe baseURL, so
  // the CSP must derive from the same variable or the two drift: the client
  // embeds one origin while the policy allows another.
  process.env.NEXT_PUBLIC_NANGO_CONNECT_URL = 'https://connect.nango.example.com/some/path'
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })

  assert.ok(frameSrcOf(csp).includes('https://connect.nango.example.com'))
})

test('an unparseable override falls back to the hosted default rather than dropping the entry', () => {
  process.env.NEXT_PUBLIC_NANGO_CONNECT_URL = 'not a url'
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })

  assert.ok(frameSrcOf(csp).includes('https://connect.nango.dev'))
})

test('the anti-clickjacking and injection directives survive edits to frame-src', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })

  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /base-uri 'self'/)
  assert.match(csp, /script-src [^;]*'nonce-test-nonce'/)
})

test('the report-only flag survives the values Vercel actually delivers', () => {
  // 'true' with a trailing newline (the CLI piping gotcha) silently ENFORCED —
  // the safety flag inverted into the blank-page rollout it exists to prevent.
  for (const value of ['true', 'true\n', ' TRUE ', '1', 'yes', 'on']) {
    process.env.CSP_REPORT_ONLY = value
    assert.equal(cspHeaderName(), 'Content-Security-Policy-Report-Only', JSON.stringify(value))
  }
})

test('unset or unrecognized values enforce — a typo must not disable the CSP', () => {
  for (const value of [undefined, '', 'false', 'report', 'enabled?']) {
    if (value === undefined) delete process.env.CSP_REPORT_ONLY
    else process.env.CSP_REPORT_ONLY = value
    assert.equal(cspHeaderName(), 'Content-Security-Policy', JSON.stringify(value))
  }
})

test('img-src admits Google avatars but stays a named-host list', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })
  const imgSrc = csp.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('img-src'))!

  assert.ok(imgSrc.includes('https://lh3.googleusercontent.com'), 'every Google-auth avatar loads from here')
  // A blanket https: would let agent-authored markdown exfiltrate data through
  // image URL query strings — the named-host list IS the control.
  assert.ok(!/img-src[^;]*\shttps:(\s|$)/.test(imgSrc), 'img-src must not admit all of https:')
})

// ── Embedding allow-list (EMBED_FRAME_ANCESTORS) ─────────────────────────────

test('unset embed allow-list keeps frame-ancestors none', () => {
  delete process.env.EMBED_FRAME_ANCESTORS
  assert.match(buildContentSecurityPolicy({ nonce: 'test-nonce' }), /frame-ancestors 'none'/)
})

test('a configured allow-list frames for those origins plus self', () => {
  process.env.EMBED_FRAME_ANCESTORS = 'https://*.lightning.force.com https://acme.my.salesforce.com'
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })
  assert.match(csp, /frame-ancestors 'self' https:\/\/\*\.lightning\.force\.com https:\/\/acme\.my\.salesforce\.com/)
  assert.equal(csp.includes("frame-ancestors 'none'"), false)
})

test('the allow-list only admits https origins — anything else is dropped', () => {
  process.env.EMBED_FRAME_ANCESTORS = "http://evil.test javascript:alert(1) https://ok.example.com 'unsafe-inline'"
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })
  const directive = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('frame-ancestors'))!
  assert.equal(directive, "frame-ancestors 'self' https://ok.example.com")
})

test('an env value that is only garbage falls back to none, not to an empty directive', () => {
  process.env.EMBED_FRAME_ANCESTORS = 'http://nope ;; img-src *'
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })
  assert.match(csp, /frame-ancestors 'none'/)
  assert.equal(csp.includes('img-src *'), false)
})

test('a directive-injection attempt cannot smuggle a semicolon into the policy', () => {
  process.env.EMBED_FRAME_ANCESTORS = 'https://a.example.com;script-src *'
  const csp = buildContentSecurityPolicy({ nonce: 'test-nonce' })
  assert.equal(csp.includes('script-src *'), false)
})
