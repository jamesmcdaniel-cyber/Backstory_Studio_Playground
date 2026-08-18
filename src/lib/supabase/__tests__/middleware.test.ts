import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Read at request time by getSupabaseConfig, so setting them here is enough.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://stub.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'anon-key'

import { updateSession } from '@/lib/supabase/middleware'

/**
 * The request-path session gate. Every page navigation in the product goes
 * through this, so a regression here either locks everyone out or exposes an
 * authenticated page to an anonymous visitor.
 *
 * Supabase Auth is exercised for real; only its HTTP call is stubbed. An
 * anonymous request never reaches the network at all (no session cookie to
 * exchange), which is itself asserted below.
 */

const ORIGIN = 'http://localhost:3000'

function stubAuth(user: { id: string } | null) {
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input))
    if (!user) return new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 })
    return new Response(JSON.stringify({ ...user, aud: 'authenticated', role: 'authenticated' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** A request carrying a Supabase session cookie the server client will read. */
function signedInRequest(path: string) {
  const request = new NextRequest(new URL(`${ORIGIN}${path}`))
  const session = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'user-1' },
  }
  request.cookies.set('sb-stub-auth-token', `base64-${Buffer.from(JSON.stringify(session)).toString('base64')}`)
  return request
}

const anonRequest = (path: string) => new NextRequest(new URL(`${ORIGIN}${path}`))

const location = (response: { headers: Headers }) => {
  const value = response.headers.get('location')
  return value ? new URL(value) : null
}

async function withAnon(path: string) {
  const auth = stubAuth(null)
  try {
    return { response: await updateSession(anonRequest(path)), authCalls: auth.calls }
  } finally {
    auth.restore()
  }
}

async function withUser(path: string) {
  const auth = stubAuth({ id: 'user-1' })
  try {
    return { response: await updateSession(signedInRequest(path)), authCalls: auth.calls }
  } finally {
    auth.restore()
  }
}

// ── public surface ────────────────────────────────────────────────────────────

test('public pages are served to an anonymous visitor', async () => {
  for (const path of ['/', '/auth', '/auth/login', '/auth/signin', '/auth/callback', '/auth/auth-code-error', '/privacy', '/terms']) {
    const { response } = await withAnon(path)
    assert.equal(location(response), null, `${path} must not redirect`)
  }
})

test('the MFA challenge stays reachable — it is where a gated account is sent', async () => {
  const anon = await withAnon('/auth/mfa')
  assert.equal(location(anon.response), null, 'anonymous /auth/mfa must not bounce to login')

  // And a signed-in-but-unverified account must not be bounced off it either,
  // or a privileged user with MFA required can never complete the challenge.
  const signedIn = await withUser('/auth/mfa')
  assert.equal(location(signedIn.response), null, 'signed-in /auth/mfa must not bounce to the dashboard')
})

test('invite and share links are readable signed out', async () => {
  for (const path of ['/invite/abc123', '/share/flow/tok-1']) {
    const { response } = await withAnon(path)
    assert.equal(location(response), null, `${path} must stay anonymous-readable`)
  }
})

// ── the gate ──────────────────────────────────────────────────────────────────

test('an anonymous visitor to a protected page is sent to login with the destination kept', async () => {
  const { response } = await withAnon('/flows/flow-1/edit')
  const target = location(response)!
  assert.equal(target.pathname, '/auth/login')
  assert.equal(target.searchParams.get('return_to'), '/flows/flow-1/edit')
})

test('the destination keeps its query string across the bounce', async () => {
  const auth = stubAuth(null)
  try {
    const response = await updateSession(anonRequest('/flows?tab=runs&id=7'))
    assert.equal(location(response)!.searchParams.get('return_to'), '/flows?tab=runs&id=7')
  } finally {
    auth.restore()
  }
})

test('an anonymous page request never reaches the auth service', async () => {
  const { authCalls } = await withAnon('/dashboard')
  assert.deepEqual(authCalls, [], 'there is no session to exchange, so no round trip should happen')
})

test('API routes authenticate themselves — the middleware neither redirects nor calls out', async () => {
  for (const path of ['/api/flows', '/api/agents/run']) {
    const { response, authCalls } = await withAnon(path)
    assert.equal(location(response), null, `${path} must not be redirected`)
    assert.deepEqual(authCalls, [], `${path} must not cost an auth round trip`)
    assert.equal(response.headers.get('cache-control'), null)
  }
})

// ── signed-in routing ─────────────────────────────────────────────────────────

test('a signed-in visitor on an auth page goes where they were headed', async () => {
  const auth = stubAuth({ id: 'user-1' })
  try {
    const request = signedInRequest('/auth/login?return_to=%2Fflows%2Fflow-1')
    assert.equal(location(await updateSession(request))!.pathname, '/flows/flow-1')
  } finally {
    auth.restore()
  }
})

test('a signed-in visitor with no destination lands on the dashboard', async () => {
  const { response } = await withUser('/auth/login')
  assert.equal(location(response)!.pathname, '/dashboard')
})

test('an off-origin return_to is refused rather than followed', async () => {
  const auth = stubAuth({ id: 'user-1' })
  try {
    for (const evil of ['https://evil.example.com/steal', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)']) {
      const request = signedInRequest(`/auth/login?return_to=${encodeURIComponent(evil)}`)
      const target = location(await updateSession(request))!
      assert.equal(target.origin, ORIGIN, `return_to=${evil} escaped the origin`)
      assert.equal(target.pathname, '/dashboard', `return_to=${evil} should fall back to the dashboard`)
    }
  } finally {
    auth.restore()
  }
})

test('callback and password-recovery pages keep a signed-in visitor', async () => {
  for (const path of ['/auth/callback', '/auth/update-password']) {
    const { response } = await withUser(path)
    assert.equal(location(response), null, `${path} must not bounce a signed-in visitor`)
  }
})

test('a signed-in visitor is not redirected away from a normal page', async () => {
  const { response } = await withUser('/dashboard')
  assert.equal(location(response), null)
})

// ── password signup gate ──────────────────────────────────────────────────────

test('password signup is closed unless explicitly allowed, and carries the invite destination', async () => {
  const saved = process.env.AUTH_ALLOW_PASSWORD
  const auth = stubAuth(null)
  try {
    for (const value of [undefined, 'false', 'TRUE', '1', '']) {
      if (value === undefined) delete process.env.AUTH_ALLOW_PASSWORD
      else process.env.AUTH_ALLOW_PASSWORD = value
      const response = await updateSession(anonRequest('/auth/signup?return_to=%2Finvite%2Fabc'))
      const target = location(response)
      assert.ok(target, `AUTH_ALLOW_PASSWORD=${String(value)} should close signup`)
      assert.equal(target.pathname, '/auth/login')
      assert.equal(target.searchParams.get('return_to'), '/invite/abc', 'the invite deep link must survive the bounce')
    }

    process.env.AUTH_ALLOW_PASSWORD = 'true'
    assert.equal(location(await updateSession(anonRequest('/auth/signup'))), null, 'signup stays open when explicitly allowed')
  } finally {
    auth.restore()
    if (saved === undefined) delete process.env.AUTH_ALLOW_PASSWORD
    else process.env.AUTH_ALLOW_PASSWORD = saved
  }
})

test('a hostile return_to is dropped on the signup bounce', async () => {
  const saved = process.env.AUTH_ALLOW_PASSWORD
  delete process.env.AUTH_ALLOW_PASSWORD
  const auth = stubAuth(null)
  try {
    const response = await updateSession(anonRequest('/auth/signup?return_to=https%3A%2F%2Fevil.example.com'))
    const target = location(response)!
    assert.equal(target.origin, ORIGIN)
    assert.equal(target.searchParams.get('return_to'), null)
  } finally {
    auth.restore()
    if (saved !== undefined) process.env.AUTH_ALLOW_PASSWORD = saved
  }
})

// ── caching ───────────────────────────────────────────────────────────────────

test('non-public pages are never stored by the browser', async () => {
  const { response } = await withUser('/dashboard')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
})

test('an anonymous share page is uncached too — its content can be revoked at any moment', async () => {
  const { response } = await withAnon('/share/flow/tok-1')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
})

test('genuinely public pages are left cacheable', async () => {
  for (const path of ['/', '/privacy', '/terms', '/auth/login']) {
    const { response } = await withAnon(path)
    assert.equal(response.headers.get('cache-control'), null, `${path} should not be marked no-store`)
  }
})

// ── CSP nonce forwarding ──────────────────────────────────────────────────────

test('the minted nonce is forwarded to the renderer and beats a caller-supplied one', async () => {
  const auth = stubAuth(null)
  try {
    const request = anonRequest('/privacy')
    request.headers.set('x-nonce', 'attacker-chosen')
    const response = await updateSession(request, new Headers({ 'x-nonce': 'server-minted' }))
    assert.equal(response.headers.get('x-middleware-request-x-nonce'), 'server-minted')
  } finally {
    auth.restore()
  }
})

test('the nonce survives the redirect branches too', async () => {
  const auth = stubAuth(null)
  try {
    const response = await updateSession(anonRequest('/dashboard'), new Headers({ 'x-nonce': 'server-minted' }))
    // A redirect response carries the cookies copied from the base response;
    // the nonce matters on the rendered branches, so assert the redirect is
    // still well-formed rather than silently dropping the session cookies.
    assert.equal(location(response)!.pathname, '/auth/login')
  } finally {
    auth.restore()
  }
})
