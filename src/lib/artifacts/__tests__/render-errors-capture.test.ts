import '@/test-support/jsdom-env'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { artifactClientRuntime } from '../client-runtime'

/**
 * The frame's own error report: what the page's runtime captures and posts to
 * the parent (src/components/artifacts/stateful-artifact-frame.tsx records it).
 */
function fixture(options: { loaded?: boolean } = {}) {
  const listeners = new Map<string, Array<(event: any) => void>>()
  const posted: any[] = []
  let consoleCalls = 0
  const states = new Map<string, { value: unknown; revision: number }>()
  const parent = {
    postMessage(message: any) {
      posted.push(message)
      if (message.type !== 'backstory:state') return
      // Shared and private values live in different stores, as the frame's two routes do.
      const slot = `${message.payload.shared ? 'shared' : 'private'}:${message.payload.key}`
      const old = states.get(slot) ?? { value: null, revision: 0 }
      let result = old
      if (message.op === 'set') { result = { value: message.payload.value, revision: old.revision + 1 }; states.set(slot, result) }
      queueMicrotask(() => { for (const fn of listeners.get('message') ?? []) fn({ source: parent, data: { type: 'backstory:state-result', id: message.id, result } }) })
    },
  }
  const runtime: any = {
    parent,
    console: { error() { consoleCalls++ } },
    addEventListener(type: string, fn: any) { listeners.set(type, [...(listeners.get(type) ?? []), fn]) },
    React: { useState: () => [0, () => {}], useEffect: () => {}, useCallback: (fn: any) => fn },
  }
  const doc = { readyState: options.loaded === false ? 'loading' : 'complete', createElement: (tag: string) => document.createElement(tag), body: document.body, documentElement: document.documentElement }
  runInNewContext(artifactClientRuntime('https://example.com'), { window: runtime, document: doc, Map, Set, Promise, setTimeout, clearTimeout, queueMicrotask })
  return {
    window: runtime,
    emit: (type: string, event: any) => { for (const fn of listeners.get(type) ?? []) fn(event) },
    reports: () => posted.filter((m) => m.type === 'backstory:render-errors'),
    stateRequests: () => posted.filter((m) => m.type === 'backstory:state'),
    consoleCalls: () => consoleCalls,
  }
}
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('runtime errors are captured from the panel, error events, rejections and console.error, de-duplicated, clipped and capped', async () => {
  const f = fixture()
  // The prelude installs its own panel; it still reports through here.
  let panelled = 0
  f.window.__artifactError = () => { panelled++ }
  for (let i = 0; i < 3; i++) f.window.__artifactError(new Error('boom'))
  f.emit('error', { error: null, message: 'Script error.' })
  f.emit('unhandledrejection', { reason: new TypeError('nope') })
  f.window.console.error('bad', { a: 1 })
  f.window.__artifactError('x'.repeat(1000))
  for (let i = 0; i < 30; i++) f.window.__artifactError(new Error(`distinct ${i}`))
  await after(120)
  assert.equal(panelled, 3 + 1 + 30, 'the page keeps its own panel')
  assert.equal(f.consoleCalls(), 1, 'console.error still reaches the console')
  const reports = f.reports()
  assert.equal(reports.length, 1, 'one report after the page loaded')
  const errors = reports[0].errors
  assert.equal(errors.length, 20, 'capped at 20')
  const boom = errors.find((e: any) => e.message === 'boom')
  assert.equal(boom.count, 3, 'the same error thrown three times is one entry with a count')
  assert.ok(boom.stack && boom.stack.length <= 500)
  assert.ok(errors.some((e: any) => e.message === 'Script error.' && !e.stack))
  assert.ok(errors.some((e: any) => e.message === 'nope'))
  assert.ok(errors.some((e: any) => e.message === 'bad {"a":1}'))
  assert.equal(errors.find((e: any) => e.message.startsWith('xxx')).message.length, 500, 'messages are clipped')
  for (const e of errors) { assert.ok(e.message.length <= 500); assert.ok(!e.stack || e.stack.length <= 500) }
})

test('nothing is posted before load; new errors after a report are throttled to one post per two seconds', async () => {
  const f = fixture({ loaded: false })
  f.window.__artifactError(new Error('early'))
  await after(120)
  assert.equal(f.reports().length, 0, 'not before the page has loaded')
  f.emit('load', {})
  await after(120)
  assert.equal(f.reports().length, 1)
  assert.equal(f.reports()[0].errors[0].message, 'early')
  f.window.__artifactError(new Error('later'))
  await after(300)
  assert.equal(f.reports().length, 1, 'a second report waits')
  await after(2000)
  assert.equal(f.reports().length, 2)
  // Array.from: the report's array was made inside the frame's realm.
  assert.deepEqual(Array.from(f.reports()[1].errors, (e: any) => e.message), ['early', 'later'])
})

test('a page with no errors posts no report', async () => {
  const f = fixture()
  await after(120)
  assert.equal(f.reports().length, 0)
})

test('shared state goes over the same bridge with the shared flag; private state does not carry it', async () => {
  const f = fixture()
  const sdk = f.window.BackstoryArtifact
  const [, , shared] = sdk.useSharedArtifactState('sheet-v1', { rows: [] })
  sdk.useArtifactState('mine-v1', { count: 0 })
  await after(10)
  assert.equal(shared.shared, true)
  const gets = f.stateRequests().filter((m) => m.op === 'get')
  assert.deepEqual(gets.map((m) => [m.payload.key, m.payload.shared]), [['sheet-v1', true], ['mine-v1', false]])
  const saved = await sdk.saveSharedState('sheet-v1', { rows: [1] }, 0)
  assert.equal(saved.revision, 1)
  const set = f.stateRequests().find((m) => m.op === 'set')
  assert.equal(set.payload.shared, true)
  assert.deepEqual((await sdk.loadSharedState('sheet-v1')).value, { rows: [1] })
  assert.equal(f.stateRequests().at(-1).payload.shared, true)
  assert.equal((await sdk.loadState('sheet-v1')).revision, 0, 'the private key of the same name is a different value')
  assert.equal(f.stateRequests().at(-1).payload.shared, undefined)
})
