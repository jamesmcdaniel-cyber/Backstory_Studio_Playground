import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setSsrfResolver,
  assertPublicUrl,
  clearPins,
  fetchPublicUrl,
  pinnedAddresses,
  pinnedLookupAnswer,
  SsrfError,
  type PinnedAddress,
} from '../ssrf'

// IP-literal cases only (no DNS/network). Hostname resolution is covered by the
// runtime guards; here we lock the IP classification + the IPv4-mapped IPv6
// bypass that the audit caught.
const blocked = (url: string) =>
  assert.rejects(assertPublicUrl(url), (e) => e instanceof SsrfError, `expected block: ${url}`)
const allowed = (url: string) =>
  assert.doesNotReject(assertPublicUrl(url), `expected allow: ${url}`)

test('rejects non-https', async () => {
  await blocked('http://8.8.8.8/')
})

test('blocks loopback / private / metadata IPv4 literals', async () => {
  await blocked('https://127.0.0.1/')
  await blocked('https://10.0.0.5/')
  await blocked('https://172.16.0.1/')
  await blocked('https://192.168.1.1/')
  await blocked('https://169.254.169.254/') // cloud metadata
  await blocked('https://100.64.0.1/')      // CGNAT
})

test('blocks IPv4-mapped IPv6 (dotted AND hex-canonical form)', async () => {
  await blocked('https://[::1]/')
  await blocked('https://[::ffff:127.0.0.1]/')       // canonicalizes to ::ffff:7f00:1
  await blocked('https://[::ffff:169.254.169.254]/') // canonicalizes to ::ffff:a9fe:a9fe
})

test('allows a public IP literal', async () => {
  await allowed('https://8.8.8.8/')
})

// ── Resolve-then-pin (DNS rebinding) ──────────────────────────────────────

/** A resolver that hands out a different answer on each call. */
function scriptedResolver(answers: PinnedAddress[][]) {
  let call = 0
  return {
    resolve: async () => answers[Math.min(call++, answers.length - 1)],
    get calls() {
      return call
    },
  }
}

const PUBLIC: PinnedAddress = { address: '93.184.216.34', family: 4 }
const PRIVATE: PinnedAddress = { address: '169.254.169.254', family: 4 }

test('pins the validated address so a rebind cannot reach the socket', async (t) => {
  // The classic attack: the guard's resolution is public, the socket's
  // resolution a moment later is the metadata endpoint.
  const script = scriptedResolver([[PUBLIC], [PRIVATE]])
  __setSsrfResolver(script.resolve)
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })

  await assertPublicUrl('https://rebind.example/api')
  assert.deepEqual(pinnedAddresses('rebind.example'), [PUBLIC], 'the approved address is pinned')

  // What the connecting socket is served next. Without the pin this would be a
  // second resolution — and the script's second answer is 169.254.169.254.
  assert.deepEqual(
    pinnedLookupAnswer('rebind.example', { all: true }),
    [PUBLIC],
    'the socket is served the validated address, not the rebound one',
  )
  assert.equal(script.calls, 1, 'the pin is served without re-asking the resolver')

  // Case-insensitive, as hostnames are.
  assert.deepEqual(pinnedLookupAnswer('ReBind.Example', { all: false }), [PUBLIC])
})

test('an unpinned host falls through to the real resolver', () => {
  clearPins()
  assert.equal(pinnedLookupAnswer('never-validated.example', { all: true }), null)
})

test('a pin that cannot satisfy the requested family reports no address, never falls through', async (t) => {
  __setSsrfResolver(async () => [PUBLIC])
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  await assertPublicUrl('https://v4only.example/')
  assert.deepEqual(pinnedLookupAnswer('v4only.example', { all: true, family: 6 }), [])
})

test('a host that rebinds to a private address is rejected on the next guard pass', async (t) => {
  const script = scriptedResolver([[PUBLIC], [PRIVATE]])
  __setSsrfResolver(script.resolve)
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  await assertPublicUrl('https://flip.example/')
  clearPins() // pin expiry / a later request
  await assert.rejects(assertPublicUrl('https://flip.example/'), (e) => e instanceof SsrfError)
})

test('any resolved address being private blocks the whole host', async (t) => {
  __setSsrfResolver(async () => [PUBLIC, PRIVATE])
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  await assert.rejects(assertPublicUrl('https://mixed.example/'), (e) => e instanceof SsrfError)
  assert.deepEqual(pinnedAddresses('mixed.example'), [], 'a rejected host is never pinned')
})

// ── fetchPublicUrl: per-hop revalidation ──────────────────────────────────

function stubFetch(script: Array<{ status: number; location?: string }>) {
  const seen: string[] = []
  let call = 0
  const impl = (async (input: string | URL | Request) => {
    seen.push(String(input))
    const step = script[Math.min(call++, script.length - 1)]
    return new Response(null, {
      status: step.status,
      headers: step.location ? { location: step.location } : undefined,
    })
  }) as unknown as typeof fetch
  return { impl, seen }
}

test('fetchPublicUrl blocks a redirect into a private address', async (t) => {
  __setSsrfResolver(async (host) => (host === 'evil.example' ? [PUBLIC] : [PRIVATE]))
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  const { impl, seen } = stubFetch([{ status: 302, location: 'https://internal.example/admin' }])
  await assert.rejects(
    fetchPublicUrl('https://evil.example/start', {}, { fetchImpl: impl }),
    (e) => e instanceof SsrfError && /private or reserved/.test((e as Error).message),
  )
  assert.deepEqual(seen, ['https://evil.example/start'], 'the private hop is never dialled')
})

test('fetchPublicUrl refuses a redirect when maxRedirects is 0', async (t) => {
  __setSsrfResolver(async () => [PUBLIC])
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  const { impl } = stubFetch([{ status: 301, location: 'https://other.example/' }])
  await assert.rejects(
    fetchPublicUrl('https://ok.example/', {}, { fetchImpl: impl, maxRedirects: 0 }),
    (e) => e instanceof SsrfError,
  )
})

test('fetchPublicUrl follows a public redirect and validates every hop', async (t) => {
  const hosts: string[] = []
  __setSsrfResolver(async (host) => {
    hosts.push(host)
    return [PUBLIC]
  })
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  const { impl, seen } = stubFetch([
    { status: 302, location: 'https://second.example/next' },
    { status: 200 },
  ])
  const response = await fetchPublicUrl('https://first.example/', {}, { fetchImpl: impl })
  assert.equal(response.status, 200)
  assert.deepEqual(seen, ['https://first.example/', 'https://second.example/next'])
  assert.deepEqual(hosts, ['first.example', 'second.example'], 'both hops went through the guard')
})

test('fetchPublicUrl happy path is a plain pass-through', async (t) => {
  __setSsrfResolver(async () => [PUBLIC])
  clearPins()
  t.after(() => {
    __setSsrfResolver(null)
    clearPins()
  })
  const { impl } = stubFetch([{ status: 200 }])
  const response = await fetchPublicUrl('https://ok.example/thing', {}, { fetchImpl: impl })
  assert.equal(response.status, 200)
  assert.deepEqual(pinnedAddresses('ok.example'), [PUBLIC])
})
