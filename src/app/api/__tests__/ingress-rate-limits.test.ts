import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * Flood tests for the ingress routes that the central write budget in
 * `api-handler` does not cover.
 *
 * Those routes are raw handlers (a signed webhook, the SCIM surface, and two
 * OAuth redirect targets), so they never pass through `withAuthenticatedApi`
 * and had no limiter of their own — an unauthenticated caller could drive
 * database work, log writes and outbound token exchanges without a ceiling.
 *
 * Each test drives the real handler past its budget and asserts a 429. Calls
 * below the budget are allowed to fail for unrelated reasons (no Supabase, no
 * database in the unit-test environment) — what is under test is that the
 * ceiling exists and is reached, which is exactly what was missing.
 */

/** Unique per test so one flood never spends another's budget. */
let ipCounter = 0
const freshIp = () => `203.0.113.${++ipCounter % 250}.${Date.now() % 1000}`

function post(url: string, ip: string, body = '{}'): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body,
  })
}

function get(url: string, ip: string): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { 'x-forwarded-for': ip } })
}

/** Call `run` until it answers 429, up to `attempts` times. */
async function floodUntilLimited(attempts: number, run: () => Promise<Response>): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    let response: Response
    try {
      response = await run()
    } catch {
      continue // an unrelated downstream failure still consumed a slot
    }
    if (response.status === 429) return response
  }
  return null
}

test('the Nango webhook caps an unauthenticated flood from one IP', async () => {
  const { POST } = await import('../nango/webhook/route')
  const ip = freshIp()
  const limited = await floodUntilLimited(700, () =>
    POST(post('https://studio.example.com/api/nango/webhook', ip)) as Promise<Response>,
  )
  assert.ok(limited, 'the webhook must answer 429 once the admission budget is spent')
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('retry-after'), '429 carries retry-after so a real webhook can back off')
  // The gate is per client: a different IP still gets in.
  const other = (await POST(post('https://studio.example.com/api/nango/webhook', freshIp()))) as Response
  assert.notEqual(other.status, 429, 'one abusive client must not lock out every other caller')
})

test('SCIM refuses a pre-auth flood from one IP before touching the database', async () => {
  const { authenticateScim, SCIM_ADMISSION_BUDGET, scimAdmissionKey } = await import('@/lib/scim/server')
  const { rateLimit } = await import('@/lib/ratelimit')
  const ip = freshIp()
  const request = get('https://studio.example.com/api/scim/v2/Users', ip)

  // Spend the budget on the route's own key, then prove the handler is gated by
  // it. Driving 1,200 handler calls would only be a slower way to do the same.
  for (let i = 0; i < SCIM_ADMISSION_BUDGET.limit; i++) {
    await rateLimit(scimAdmissionKey(request), SCIM_ADMISSION_BUDGET)
  }
  const response = await authenticateScim(request)
  assert.ok(response instanceof Response, 'a flooded caller is rejected, never authenticated')
  assert.equal((response as Response).status, 429)

  // Untouched clients are unaffected.
  const fresh = await authenticateScim(get('https://studio.example.com/api/scim/v2/Users', freshIp()))
  assert.ok(fresh instanceof Response)
  assert.equal((fresh as Response).status, 401, 'a normal caller still gets the ordinary auth failure')
})

test('the MCP OAuth callback caps a flood from one IP', async () => {
  const { GET } = await import('../mcp-connections/oauth/callback/route')
  const ip = freshIp()
  const limited = await floodUntilLimited(60, () =>
    GET(get('https://studio.example.com/api/mcp-connections/oauth/callback?code=x&state=y', ip)) as Promise<Response>,
  )
  assert.ok(limited, 'the callback must answer 429 once its budget is spent')
  assert.equal(limited.status, 429)
})

test('the People.ai OAuth callback caps a flood from one IP', async () => {
  const { GET } = await import('../peopleai/callback/route')
  const ip = freshIp()
  const limited = await floodUntilLimited(60, () =>
    GET(get('https://studio.example.com/api/peopleai/callback?code=x&state=y', ip)) as Promise<Response>,
  )
  assert.ok(limited, 'the callback must answer 429 once its budget is spent')
  assert.equal(limited.status, 429)
})
