import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactSharedChannel, createSharedStateRelay, parseSharedTick } from '../shared-state-live'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A relay over a fake authenticated GET whose server value the test moves. */
function fixture(options: { debounceMs?: number; maxWaitMs?: number } = {}) {
  const server = new Map<string, { value: unknown; revision: number }>()
  const fetches: string[] = []
  const delivered: Array<{ key: string; value: unknown; revision: number }> = []
  let failNext = false
  const relay = createSharedStateRelay({
    fetchLatest: async (key) => {
      fetches.push(key)
      if (failNext) { failNext = false; throw new Error('offline') }
      return server.get(key) ?? { value: null, revision: 0 }
    },
    deliver: (change) => delivered.push(change),
    debounceMs: options.debounceMs ?? 20,
    maxWaitMs: options.maxWaitMs ?? 200,
  })
  const save = (key: string, value: unknown) => {
    const revision = (server.get(key)?.revision ?? 0) + 1
    server.set(key, { value, revision })
    return revision
  }
  return { relay, server, fetches, delivered, save, failOnce() { failNext = true } }
}

test('the topic and the tick: artifact-scoped, key + revision only', () => {
  assert.equal(artifactSharedChannel('a1b2'), 'artifact-shared:a1b2')
  assert.deepEqual(parseSharedTick({ key: 'sheet-v1', revision: 3 }), { key: 'sheet-v1', revision: 3 })
  for (const bad of [null, 'x', {}, { key: 'bad key', revision: 1 }, { key: 'k', revision: 0 }, { key: 'k', revision: 1.5 }, { key: 'k', revision: '2' }]) {
    assert.equal(parseSharedTick(bad), null, JSON.stringify(bad))
  }
})

test('another viewer\'s save is refetched and delivered; unwatched keys and stale ticks are not', async () => {
  const f = fixture()
  f.relay.tick({ key: 'sheet-v1', revision: 1 })
  await wait(40)
  assert.deepEqual(f.fetches, [], 'a key the frame never asked about is not followed')
  f.relay.watch('sheet-v1')
  f.relay.observe('sheet-v1', 1) // the frame read revision 1
  f.save('sheet-v1', { rows: ['a'] })
  f.relay.tick({ key: 'sheet-v1', revision: 1 })
  await wait(40)
  assert.deepEqual(f.fetches, [], 'a revision the frame already holds is dropped')
  f.save('sheet-v1', { rows: ['a', 'b'] })
  f.relay.tick({ key: 'sheet-v1', revision: f.save('sheet-v1', { rows: ['a', 'b'] }) })
  await wait(40)
  assert.deepEqual(f.delivered, [{ key: 'sheet-v1', value: { rows: ['a', 'b'] }, revision: 3 }])
  f.relay.tick({ key: 'sheet-v1', revision: 3 })
  await wait(40)
  assert.equal(f.fetches.length, 1, 'the same revision again is not refetched')
})

test('the echo of the frame\'s own save is dropped, even when the tick beats the PUT response', async () => {
  const f = fixture()
  f.relay.watch('votes')
  f.relay.observe('votes', 4)
  f.relay.beginWrite('votes')
  const mine = f.save('votes', { yes: 5 }) // committed; the response is still on its way
  f.relay.tick({ key: 'votes', revision: mine })
  await wait(40)
  assert.deepEqual(f.fetches, [], 'held while the write is in flight')
  f.relay.endWrite('votes', mine)
  await wait(40)
  assert.deepEqual([f.fetches, f.delivered], [[], []], 'it was our own revision: nothing to deliver')
})

test('someone else\'s save that lands while ours is in flight is delivered once ours settles', async () => {
  const f = fixture()
  f.relay.watch('votes')
  f.relay.observe('votes', 1)
  f.relay.beginWrite('votes')
  const mine = f.save('votes', { yes: 1 })
  const theirs = f.save('votes', { yes: 2 })
  f.relay.tick({ key: 'votes', revision: theirs })
  f.relay.tick({ key: 'votes', revision: mine })
  await wait(40)
  assert.deepEqual(f.fetches, [])
  f.relay.endWrite('votes', mine)
  await wait(40)
  assert.deepEqual(f.delivered, [{ key: 'votes', value: { yes: 2 }, revision: theirs }])
})

test('a failed write releases held ticks too', async () => {
  const f = fixture()
  f.relay.watch('votes')
  f.relay.beginWrite('votes')
  const theirs = f.save('votes', { yes: 9 })
  f.relay.tick({ key: 'votes', revision: theirs })
  f.relay.endWrite('votes') // our CAS lost
  await wait(40)
  assert.deepEqual(f.delivered, [{ key: 'votes', value: { yes: 9 }, revision: 1 }])
})

test('a burst coalesces into one fetch, and a constant stream still refreshes by the cap', async () => {
  const f = fixture({ debounceMs: 30, maxWaitMs: 100 })
  f.relay.watch('notes')
  for (let i = 0; i < 5; i++) f.relay.tick({ key: 'notes', revision: f.save('notes', `v${i}`) })
  await wait(60)
  assert.equal(f.fetches.length, 1, 'five ticks, one refetch')
  assert.deepEqual(f.delivered.at(-1), { key: 'notes', value: 'v4', revision: 5 })
  const stream = setInterval(() => f.relay.tick({ key: 'notes', revision: f.save('notes', 'live') }), 10)
  await wait(160)
  clearInterval(stream)
  assert.ok(f.fetches.length >= 2, 'a key that never stops changing is still refreshed within the cap')
})

test('a failed refetch is quiet and the next tick recovers; nothing is delivered after dispose', async () => {
  const f = fixture()
  f.relay.watch('notes')
  f.failOnce()
  f.relay.tick({ key: 'notes', revision: f.save('notes', 'one') })
  await wait(40)
  assert.deepEqual(f.delivered, [])
  f.relay.tick({ key: 'notes', revision: f.save('notes', 'two') })
  await wait(40)
  assert.deepEqual(f.delivered, [{ key: 'notes', value: 'two', revision: 2 }])
  f.relay.tick({ key: 'notes', revision: f.save('notes', 'three') })
  f.relay.dispose()
  await wait(40)
  assert.equal(f.delivered.length, 1)
})

test('a frame follows at most 32 keys, and only valid ones', () => {
  const f = fixture()
  assert.equal(f.relay.watch('bad key!'), false)
  for (let i = 0; i < 32; i++) assert.equal(f.relay.watch(`k${i}`), true)
  assert.equal(f.relay.watch('k32'), false)
  assert.equal(f.relay.watch('k0'), true, 'an already-followed key is still fine')
})

test('the server broadcaster sends key + revision on the artifact topic, never the value', async () => {
  const { broadcastSharedStateTick } = await import('../shared-state')
  const original = globalThis.fetch
  const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }
  const calls: Array<{ url: string; body: string }> = []
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), body: String(init.body) }); return new Response('{}') }) as typeof fetch
  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    assert.equal(broadcastSharedStateTick('art-1', { key: 'sheet-v1', revision: 2 }), undefined, 'no Supabase, no broadcast')
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    await broadcastSharedStateTick('art-1', { key: 'sheet-v1', revision: 2 })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://example.supabase.co/realtime/v1/api/broadcast')
    assert.deepEqual(JSON.parse(calls[0].body), { messages: [{ topic: 'artifact-shared:art-1', event: 'tick', payload: { key: 'sheet-v1', revision: 2 } }] })
  } finally {
    globalThis.fetch = original
    if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url
    if (env.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = env.key
  }
})
