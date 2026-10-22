import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { artifactClientRuntime } from '../client-runtime'

/**
 * The frame's side of live shared state: a fake viewer bridge that holds the
 * server's shared value (with the real compare-and-set), and `push` — what the
 * viewer sends when another person's save lands.
 */
function fixture(options: { slowFirstRead?: boolean } = {}) {
  let listener: (event: any) => void = () => {}
  const server = new Map<string, { value: unknown; revision: number }>()
  const sent: any[] = []
  let renders = 0
  let holdSet: (() => void) | null = null
  let holdSets = false
  const parent = { postMessage(message: any) {
    sent.push(message)
    if (message.type !== 'backstory:state') return
    const { key, value, revision } = message.payload
    const current = server.get(key) ?? { value: null, revision: 0 }
    let result: any = current
    let error: string | undefined
    if (message.op === 'set') {
      if (revision !== current.revision) error = 'Shared data changed elsewhere. Reload to reconcile.'
      else { result = { value, revision: current.revision + 1 }; server.set(key, result) }
    }
    const answer = () => listener({ source: parent, data: { type: 'backstory:state-result', id: message.id, result: error ? undefined : { revision: result.revision, value: result.value }, error } })
    if (message.op === 'set' && holdSets) { holdSet = answer; return }
    if (message.op === 'get' && options.slowFirstRead) { options.slowFirstRead = false; setTimeout(answer, 30); return }
    queueMicrotask(answer)
  } }
  const React = { useState: () => [0, () => { renders += 1 }], useEffect: (fn: () => void) => { fn() }, useCallback: (fn: any) => fn }
  const runtime: any = { parent, addEventListener(type: string, fn: any) { if (type === 'message') listener = fn }, React }
  runInNewContext(artifactClientRuntime('https://example.com'), { window: runtime, document, Map, Set, Promise, setTimeout, clearTimeout, Array, JSON })
  const sdk = runtime.BackstoryArtifact
  return {
    sdk,
    sent,
    renders: () => renders,
    shared: () => sdk.useSharedArtifactState('sheet-v1', { rows: [] }),
    /** Someone else saved: move the server value and relay it as the viewer would. */
    remote(key: string, value: unknown) {
      const revision = (server.get(key)?.revision ?? 0) + 1
      server.set(key, { value, revision })
      listener({ source: parent, data: { type: 'backstory:shared-state-changed', key, value, revision } })
      return revision
    },
    push(data: Record<string, unknown>) { listener({ source: parent, data: { type: 'backstory:shared-state-changed', ...data } }) },
    seed(key: string, value: unknown, revision: number) { server.set(key, { value, revision }) },
    holdSets(value: boolean) { holdSets = value },
    releaseSet() { const fn = holdSet; holdSet = null; fn?.() },
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
/** Past the 400 ms coalescing window, so a set() has gone out and come back. */
const settle = () => new Promise(resolve => setTimeout(resolve, 450))

test('another viewer\'s save updates a clean shared slot and re-renders it', async () => {
  const f = fixture()
  f.seed('sheet-v1', { rows: ['a'] }, 1)
  f.shared(); await flush()
  assert.deepEqual(f.shared()[0], { rows: ['a'] })
  const before = f.renders()
  const revision = f.remote('sheet-v1', { rows: ['a', 'b'] })
  assert.ok(f.renders() > before, 'the component re-rendered')
  assert.deepEqual(f.shared()[0], { rows: ['a', 'b'] })
  assert.equal(f.shared()[2].stale, false)
  // The page's next save builds on the revision it was handed: no conflict.
  f.shared()[1]({ rows: ['a', 'b', 'c'] }); await settle()
  assert.equal(f.shared()[2].error, null)
  const set = f.sent.filter(m => m.op === 'set').at(-1)
  assert.equal(set.payload.revision, revision)
})

test('the echo of the page\'s own save and stale deliveries are ignored', async () => {
  const f = fixture()
  f.shared(); await flush()
  f.shared()[1]({ rows: ['mine'] }); await settle()
  assert.equal(f.shared()[2].dirty, false)
  const before = f.renders()
  f.push({ key: 'sheet-v1', value: { rows: ['echo'] }, revision: 1 })
  f.push({ key: 'sheet-v1', value: { rows: ['older'] }, revision: 0 })
  assert.equal(f.renders(), before, 'a revision the slot already holds does not re-render')
  assert.deepEqual(f.shared()[0], { rows: ['mine'] }, 'and changes nothing')
  for (const bad of [{ key: 7, value: 1, revision: 9 }, { key: 'sheet-v1', value: 1, revision: '9' }]) f.push(bad)
  assert.deepEqual(f.shared()[0], { rows: ['mine'] })
})

test('an unsaved local edit is kept; the next save gets the existing conflict path', async () => {
  const f = fixture()
  f.shared(); await flush()
  f.shared()[1]({ rows: ['draft'] }) // still in the coalescing window
  f.remote('sheet-v1', { rows: ['theirs'] })
  assert.deepEqual(f.shared()[0], { rows: ['draft'] }, 'the draft is not overwritten')
  assert.equal(f.shared()[2].stale, true, 'the page can tell a newer value exists')
  await settle()
  assert.match(f.shared()[2].error, /changed elsewhere/, 'the save met the revision check')
  assert.deepEqual(f.shared()[0], { rows: ['draft'] }, 'the draft is retained after the conflict')
  await f.shared()[2].reload()
  assert.deepEqual(f.shared()[0], { rows: ['theirs'] })
  assert.equal(f.shared()[2].stale, false)
  assert.equal(f.shared()[2].error, null)
})

test('a change that arrives while the page\'s own save is in flight does not clobber it', async () => {
  const f = fixture()
  f.shared(); await flush()
  f.holdSets(true)
  f.shared()[1]({ rows: ['mine'] })
  await new Promise(resolve => setTimeout(resolve, 420)) // the set is out, unanswered
  assert.equal(f.shared()[2].saving, true)
  f.push({ key: 'sheet-v1', value: { rows: ['racing'] }, revision: 5 })
  assert.deepEqual(f.shared()[0], { rows: ['mine'] })
  f.holdSets(false); f.releaseSet(); await flush(); await flush()
  assert.equal(f.shared()[2].saving, false)
  // The viewer delivers the newer value once the save settles (its relay holds it); now it applies.
  f.push({ key: 'sheet-v1', value: { rows: ['racing'] }, revision: 5 })
  assert.deepEqual(f.shared()[0], { rows: ['racing'] })
})

test('a change delivered while the slot is still loading wins over an older read', async () => {
  const f = fixture({ slowFirstRead: true })
  f.seed('sheet-v1', { rows: ['old'] }, 1)
  f.shared()
  f.push({ key: 'sheet-v1', value: { rows: ['new'] }, revision: 2 })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.shared()[2].ready, true)
  assert.deepEqual(f.shared()[0], { rows: ['new'] })
})

test('HTML pages: onSharedStateChange follows the key, skips its own save\'s echo, and hears others', async () => {
  const f = fixture()
  const heard: any[] = []
  const off = f.sdk.onSharedStateChange('votes', (change: any) => heard.push(change))
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.find(m => m.type === 'backstory:shared-watch'))), { type: 'backstory:shared-watch', key: 'votes' }, 'the viewer is told to follow it')
  const saved = await f.sdk.saveSharedState('votes', { yes: 1 }, 0)
  f.push({ key: 'votes', value: { yes: 1 }, revision: saved.revision })
  assert.deepEqual(heard, [], 'its own save is not reported back')
  f.remote('votes', { yes: 2 })
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [{ key: 'votes', value: { yes: 2 }, revision: 2 }])
  off()
  f.remote('votes', { yes: 3 })
  assert.equal(heard.length, 1, 'unsubscribed')
  assert.throws(() => f.sdk.onSharedStateChange('bad key', () => {}))
})

test('HTML pages: a change during an in-flight saveSharedState is judged after the save lands', async () => {
  const f = fixture()
  const heard: any[] = []
  f.sdk.onSharedStateChange('votes', (change: any) => heard.push(change.revision))
  f.holdSets(true)
  const saving = f.sdk.saveSharedState('votes', { yes: 1 }, 0)
  await flush()
  f.push({ key: 'votes', value: { yes: 1 }, revision: 1 }) // the echo beats the response
  assert.deepEqual(heard, [])
  f.releaseSet(); await saving
  assert.deepEqual(heard, [], 'it was the page\'s own revision')
  f.holdSets(true)
  const second = f.sdk.saveSharedState('votes', { yes: 2 }, 1)
  await flush()
  f.push({ key: 'votes', value: { yes: 9 }, revision: 3 }) // someone else, after ours
  f.releaseSet(); await second
  assert.deepEqual(heard, [3], 'a newer change is reported once the save settles')
})

test('with no viewer (public link, thumbnail) live hooks are inert, not errors', async () => {
  const runtime: any = { addEventListener() {}, React: { useState: () => [0, () => {}], useEffect: () => {}, useCallback: (fn: any) => fn } }
  runtime.parent = runtime
  const posted: any[] = []
  runtime.postMessage = (m: any) => posted.push(m)
  runInNewContext(artifactClientRuntime('https://example.com'), { window: runtime, document, Map, Set, Promise, setTimeout, clearTimeout, Array, JSON })
  const off = runtime.BackstoryArtifact.onSharedStateChange('votes', () => {})
  assert.equal(typeof off, 'function')
  assert.deepEqual(posted, [], 'nothing is posted to itself')
  const state = () => runtime.BackstoryArtifact.useSharedArtifactState('votes', { yes: 0 })
  state(); await flush()
  assert.equal(state()[2].ready, true); assert.equal(state()[2].readOnly, true); assert.equal(state()[2].error, null)
})
