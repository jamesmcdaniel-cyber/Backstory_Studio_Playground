import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderHook, act, cleanup } from '@testing-library/react'
import { useCachedJson, resetCachedJson } from '../use-cached-json'
import { getSnapshot, resetSnapshotCache, peekSnapshot } from '../snapshot'

test('session reset rejects late responses even when fetch ignores abort', async () => {
  const original = globalThis.fetch
  let resolve!: (r: Response) => void
  globalThis.fetch = () => new Promise(r => { resolve = r })
  try {
    resetCachedJson()
    const hook = renderHook(() => useCachedJson('/api/private-fixture'))
    await act(async () => { resetCachedJson(); resolve(Response.json({ oldUser: 'secret' })) })
    assert.equal(localStorage.getItem('bs:swr:/api/private-fixture'), null)
    assert.equal(hook.result.current.data, undefined)
  } finally { cleanup(); resetCachedJson(); globalThis.fetch = original }
})

test('snapshot rejects an old-session response instead of returning it to mounted consumers', async () => {
  const original = globalThis.fetch
  let resolve!: (r: Response) => void
  globalThis.fetch = () => new Promise(r => { resolve = r })
  try {
    resetSnapshotCache()
    const pending = getSnapshot(0)
    resetSnapshotCache()
    resolve(Response.json({ agents: [{ id: 'old-session' }] }))
    await assert.rejects(pending, /Session changed/)
    assert.equal(peekSnapshot(), null)
  } finally { resetSnapshotCache(); globalThis.fetch = original }
})

test('optimistic mutation cannot be overwritten by a stale shared fetch', async () => {
  const original = globalThis.fetch
  let resolve!: (r: Response) => void
  globalThis.fetch = () => new Promise(r => { resolve = r })
  try {
    const hook = renderHook(() => useCachedJson<{ value: number }>('/api/mutation-fixture'))
    await act(async () => { hook.result.current.mutate({ value: 2 }); resolve(Response.json({ value: 1 })) })
    assert.deepEqual(hook.result.current.data, { value: 2 })
    assert.equal(JSON.parse(localStorage.getItem('bs:swr:/api/mutation-fixture')!).data.value, 2)
  } finally { cleanup(); resetCachedJson(); globalThis.fetch = original }
})
