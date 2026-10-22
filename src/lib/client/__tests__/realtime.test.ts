import test from 'node:test'
import assert from 'node:assert/strict'
import { subscribeTicks } from '../realtime'

/** Behaves like supabase-js: one channel object per topic, and subscribing it twice throws. */
function fakeClient() {
  const channels = new Map<string, any>()
  let subscribes = 0
  let removed = 0
  const client = {
    channel(topic: string) {
      if (!channels.has(topic)) {
        const handlers: Array<(message?: unknown) => void> = []
        const channel: any = {
          state: 'closed',
          on(_type: string, _filter: unknown, handler: (message?: unknown) => void) { handlers.push(handler); return channel },
          subscribe() {
            if (channel.state !== 'closed') throw new Error("tried to subscribe multiple times. 'subscribe' can only be called a single time per channel instance")
            channel.state = 'joined'
            subscribes += 1
            return channel
          },
          fire(message?: unknown) { for (const handler of handlers) handler(message) },
        }
        channels.set(topic, channel)
      }
      return channels.get(topic)
    },
    async removeChannel(channel: any) { removed += 1; channel.state = 'closed'; for (const [k, v] of channels) if (v === channel) channels.delete(k); return 'ok' },
  }
  return { client: client as any, channels, counts: () => ({ subscribes, removed }) }
}

test('two components following the same run share one subscription — no "subscribe multiple times" crash', async () => {
  const fake = fakeClient()
  let a = 0
  let b = 0
  const offA = subscribeTicks('agent-exec:run-1', () => { a += 1 }, () => fake.client)
  const offB = subscribeTicks('agent-exec:run-1', () => { b += 1 }, () => fake.client)
  assert.equal(fake.counts().subscribes, 1, 'subscribed once')
  fake.channels.get('agent-exec:run-1').fire()
  assert.deepEqual([a, b], [1, 1], 'both listeners hear the tick')
  offA()
  fake.channels.get('agent-exec:run-1').fire()
  assert.deepEqual([a, b], [1, 2], 'a listener that left hears nothing more')
  offB()
  // An immediate remount (React does this) reuses the channel instead of racing its removal.
  const offC = subscribeTicks('agent-exec:run-1', () => {}, () => fake.client)
  assert.equal(fake.counts().subscribes, 1)
  offC()
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.equal(fake.counts().removed, 1, 'the channel is removed once nobody listens')
})

test('without Supabase configured, subscribing is a no-op', () => {
  const off = subscribeTicks('agent-exec:run-2', () => {}, () => { throw new Error('Supabase is not configured') })
  assert.doesNotThrow(off)
})

test('listeners receive the tick\'s payload (identifiers only — the artifact shared-state plane reads key + revision)', async () => {
  const fake = fakeClient()
  const heard: unknown[] = []
  const off = subscribeTicks('artifact-shared:a1', (payload) => { heard.push(payload) }, () => fake.client)
  fake.channels.get('artifact-shared:a1').fire({ type: 'broadcast', event: 'tick', payload: { key: 'sheet-v1', revision: 2 } })
  fake.channels.get('artifact-shared:a1').fire()
  assert.deepEqual(heard, [{ key: 'sheet-v1', revision: 2 }, undefined])
  off()
  await new Promise((resolve) => setTimeout(resolve, 1_100))
})
