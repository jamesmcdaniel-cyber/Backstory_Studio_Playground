import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { artifactClientRuntime } from '../client-runtime'

function fixture() {
  let listener: (event: any) => void
  let saved: { value: Record<string, unknown>; revision: number } = { value: { count: 0 }, revision: 1 }
  let failRead = false, failWrite = false, loseResponse = false
  const writes: any[] = []
  const parent = { postMessage(message: any) {
    if (message.type !== 'backstory:state') return
    let error: string | undefined
    if (message.op === 'get' && failRead) error = 'offline read'
    if (message.op === 'set') {
      writes.push(message.payload)
      if (failWrite) error = 'offline write'
      else if (message.payload.revision !== saved.revision) error = 'revision conflict'
      else { saved = { value: Object.fromEntries(Object.entries(message.payload.value).sort(([a], [b]) => a.localeCompare(b))), revision: saved.revision + 1 }; if (loseResponse) error = 'response lost' }
    }
    queueMicrotask(() => listener({ source: parent, data: { type: 'backstory:state-result', id: message.id, result: saved, error } }))
  } }
  const runtime: any = { parent, addEventListener(type: string, fn: any) { if (type === 'message') listener = fn }, React: { useState: () => [0, () => {}], useEffect: () => {}, useCallback: (fn: any) => fn } }
  runInNewContext(artifactClientRuntime('https://example.com'), { window: runtime, document, Map, Set, Promise, setTimeout, clearTimeout })
  return { state: () => runtime.BackstoryArtifact.useArtifactState('fixture', { count: 0 }), writes, offlineRead(value: boolean) { failRead = value }, offlineWrite(value: boolean) { failWrite = value }, lostResponse(value: boolean) { loseResponse = value }, remote(value: any) { saved = { value, revision: saved.revision + 1 } } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
/** Past the coalescing window, so a set() has been sent. */
const settle = () => new Promise(resolve => setTimeout(resolve, 450))

test('failed initial read is retryable without a page reload', async () => {
  const f = fixture(); f.offlineRead(true); f.state(); await flush()
  assert.match(f.state()[2].error, /offline read/)
  f.offlineRead(false); await f.state()[2].retry()
  assert.equal(f.state()[2].ready, true); assert.equal(f.state()[2].error, null)
})

test('transient save keeps draft and retries; lost response does not duplicate writes', async () => {
  const f = fixture(); f.state(); await flush()
  f.offlineWrite(true); f.state()[1]({ count: 2 }); await flush()
  assert.equal(f.state()[0].count, 2); assert.equal(f.state()[2].dirty, true)
  f.offlineWrite(false); await f.state()[2].retry()
  assert.equal(f.state()[2].error, null); assert.equal(f.state()[2].dirty, false)
  f.lostResponse(true); f.state()[1]({ z: 4, count: 3 }); await settle()
  const count = f.writes.length
  await f.state()[2].retry()
  assert.equal(f.writes.length, count); assert.equal(f.state()[2].error, null)
})

test('conflicting remote save never overwrites the retained draft or remote data', async () => {
  const f = fixture(); f.state(); await flush()
  f.offlineWrite(true); f.state()[1]({ count: 2 }); await settle()
  f.offlineWrite(false); f.remote({ count: 99 }); const count = f.writes.length
  await f.state()[2].retry()
  assert.equal(f.writes.length, count); assert.equal(f.state()[0].count, 2)
  assert.match(f.state()[2].error, /Another save changed/)
  await f.state()[2].reload()
  assert.equal(f.state()[0].count, 99); assert.equal(f.state()[2].dirty, false)
})

test('writes within the coalescing window become one save, and typing alone is not a draft', async () => {
  const f = fixture(); f.state(); await flush()
  f.state()[1]({ count: 1 }); f.state()[1]({ count: 2 }); f.state()[1]({ count: 3 })
  assert.equal(f.state()[2].saving, true); assert.equal(f.writes.length, 0)
  await settle()
  assert.equal(f.writes.length, 1); assert.equal(JSON.stringify(f.writes[0].value), '{"count":3}')
  assert.equal(f.state()[2].dirty, false)
  document.body.dispatchEvent(new Event('input', { bubbles: true }))
  assert.equal(f.state()[2].dirty, false, 'an input event does not mark the page dirty')
})

test('with no state bridge the slot becomes ready and read-only instead of failing', async () => {
  const runtime: any = { parent: { postMessage() {} }, addEventListener() {}, React: { useState: () => [0, () => {}], useEffect: () => {}, useCallback: (fn: any) => fn } }
  runInNewContext(artifactClientRuntime('https://example.com'), { window: runtime, document, Map, Set, Promise, setTimeout, clearTimeout })
  const state = () => runtime.BackstoryArtifact.useArtifactState('silent', { count: 0 })
  state()
  await new Promise(resolve => setTimeout(resolve, 4200))
  assert.equal(state()[2].ready, true); assert.equal(state()[2].readOnly, true); assert.equal(state()[2].error, null)
  state()[1]({ count: 5 })
  assert.equal(state()[0].count, 5); assert.equal(state()[2].dirty, false)
})
