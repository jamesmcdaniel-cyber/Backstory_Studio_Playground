import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { useRef } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { FakeRealtime } from './support/fake-realtime'
import { useJamChannel, type JamChannel } from '../use-jam-channel'

/** The join awaits setAuth, so a few microtask turns pass before the channel
 *  is actually subscribed. */
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

type Probe = { status?: string; subscribes: number; bound: JamChannel[] }

function Harness({ hub, probe }: { hub: FakeRealtime; probe: Probe }) {
  const channelRef = useRef<JamChannel | null>(null)
  probe.status = useJamChannel({
    client: hub as never,
    topic: 'flow:f1',
    enabled: true,
    presenceKey: 'c1',
    channelRef,
    bind: (channel) => probe.bound.push(channel),
    onSubscribed: () => { probe.subscribes++ },
  })
  return null
}

function mount(hub: FakeRealtime): Probe {
  const probe: Probe = { subscribes: 0, bound: [] }
  render(<Harness hub={hub} probe={probe} />)
  return probe
}

test('the fake enforces the real one-subscribe-per-instance contract', () => {
  const hub = new FakeRealtime()
  const channel = hub.channel('flow:x')
  channel.subscribe()
  assert.throws(() => channel.subscribe())
})

test('a server-closed channel reconnects on a fresh instance and goes live again', async (t) => {
  t.after(cleanup)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hub = new FakeRealtime()
  const probe = mount(hub)
  await settle()
  assert.equal(probe.status, 'live')
  assert.equal(probe.subscribes, 1)
  assert.equal(hub.created.length, 1)

  // Supabase Realtime restarts or idle-kicks the channel: the client library
  // removes it from the socket and never rejoins it on its own.
  act(() => hub.created[0].serverClose())
  assert.equal(probe.status, 'degraded')

  await act(async () => { t.mock.timers.tick(1_000) })
  await settle()

  assert.equal(probe.status, 'live', 'the jam must come back without a page reload')
  assert.equal(probe.subscribes, 2, 'resubscribe fires so presence is re-tracked')
  assert.equal(hub.created.length, 2, 'recovery happens on a fresh channel instance')
  assert.equal(probe.bound.length, 2, 'the fresh instance is re-bound before subscribing')
  const members = hub.members('flow:f1')
  assert.equal(members.length, 1, 'exactly one live membership after recovery')
  assert.equal(members[0], hub.created[1])
})

test('a refused or failed join keeps retrying and recovers', async (t) => {
  t.after(cleanup)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hub = new FakeRealtime()
  const probe = mount(hub)
  await settle()
  assert.equal(probe.status, 'live')

  act(() => hub.created[0].serverError())
  assert.equal(probe.status, 'error')

  await act(async () => { t.mock.timers.tick(1_000) })
  await settle()
  assert.equal(probe.status, 'live')
  assert.equal(hub.created.length, 2)
})

test('coming back online retries immediately instead of waiting out the backoff', async (t) => {
  t.after(cleanup)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hub = new FakeRealtime()
  const probe = mount(hub)
  await settle()

  act(() => hub.created[0].serverClose())
  assert.equal(probe.status, 'degraded')

  // No timer tick: waking the network fires the retry now.
  await act(async () => {
    window.dispatchEvent(new Event('online'))
  })
  await settle()
  assert.equal(probe.status, 'live')
})

test('unmount while a retry is pending neither retries nor throws', async (t) => {
  t.after(cleanup)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hub = new FakeRealtime()
  const probe = mount(hub)
  await settle()

  act(() => hub.created[0].serverClose())
  cleanup()
  await act(async () => { t.mock.timers.tick(60_000) })
  assert.equal(hub.created.length, 1, 'no new channel after unmount')
  assert.equal(probe.status, 'degraded')
})
