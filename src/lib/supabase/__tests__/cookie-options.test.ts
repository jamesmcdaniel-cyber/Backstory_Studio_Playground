import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SUPABASE_COOKIE_OPTIONS } from '../config'

test('the session cookie is Secure in production and sameSite lax', () => {
  // NODE_ENV is not 'production' under the test runner, so assert the shape and
  // the rule rather than the resolved boolean.
  assert.equal(SUPABASE_COOKIE_OPTIONS.sameSite, 'lax')
  assert.equal(SUPABASE_COOKIE_OPTIONS.secure, process.env.NODE_ENV === 'production')
})

test('httpOnly is deliberately not forced — the browser client reads the cookie', () => {
  // Setting it would sign every user out (createBrowserClient uses
  // document.cookie). Pinned so nobody "hardens" it into an outage.
  assert.equal('httpOnly' in SUPABASE_COOKIE_OPTIONS, false)
})

test('every createServerClient call site passes the shared options', () => {
  // The default options omit `secure` entirely, so a new call site that forgets
  // this silently reintroduces a token cookie that survives an http downgrade.
  for (const path of ['src/lib/supabase/server.ts', 'src/lib/supabase/middleware.ts']) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, /createServerClient\(/, `${path} should create a server client`)
    assert.match(source, /cookieOptions: SUPABASE_COOKIE_OPTIONS/, `${path} must pass the shared cookie options`)
  }
})
