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
        const handlers: Array<() => void> = []
        const channel: any = {
          state: 'closed',
          on(_type: string, _filter: unknown, handler: () => void) { handlers.push(handler); return channel },
          subscribe() {
            if (channel.state !== 'closed') throw new Error("tried to subscribe multiple times. 'subscribe' can only be called a single time per channel instance")
            channel.state = 'joined'
            subscribes += 1
            return channel
          },
          fire() { for (const handler of handlers) handler() },
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
