import test from 'node:test'
import assert from 'node:assert/strict'
import { Script, runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { loadPyodide } from 'pyodide'
import { requestsArtifact, ARTIFACT_DIRECTIVE } from '../directive'
import { validateArtifactContent, validateArtifactPython } from '../validate-content'
import { artifactClientRuntime } from '../client-runtime'
import { needsArtifactRender } from '@/features/agents/artifact-renderer'

test('validator permits viewer-compatible form events but forbids external submission', () => {
  const runner = readFileSync('services/artifact-validator/runner.mjs', 'utf8')
  assert.match(runner, /sandbox="[^"]*allow-forms/)
  assert.match(runner, /sandbox allow-scripts allow-forms/)
  assert.match(runner, /form-action 'none'/)
  assert.doesNotMatch(runner, /allow-same-origin/)
})

test('@artifact recognizes explicit instruction directives, not email or partial words', () => {
  for (const text of ['@artifact Build a calculator', 'Please build @ artifact', '\n@ARTIFACT\n', 'Build this with @artifact.']) assert.equal(requestsArtifact(text), true)
  for (const text of ['jane@artifact.com', '@artifacts', 'ordinary report']) assert.equal(requestsArtifact(text), false)
  assert.equal(requestsArtifact(null, undefined, '@artifact'), true)
  assert.match(ARTIFACT_DIRECTIVE, /complete executable interactive application/)
  assert.match(ARTIFACT_DIRECTIVE, /linked to this agent/)
})

test('source validation rejects broken code and unsupported imports without executing it', () => {
  assert.throws(() => validateArtifactContent('<script>const = ;</script>'), /failed validation/)
  assert.throws(() => validateArtifactContent('export default function App( {return <div/>}'), /failed validation/)
  assert.throws(() => validateArtifactContent('import x from "unavailable"; export default function App(){return <div>{x}</div>}'), /Unsupported artifact import/)
  assert.throws(() => validateArtifactContent('x'.repeat(2_000_001)), /exceeds/)
  assert.doesNotThrow(() => validateArtifactContent('<script>throw new Error("not executed")</script>'))
  assert.doesNotThrow(() => validateArtifactContent('import {runPython} from "@backstory/artifact"; export default function App(){return <div/>}'))
  assert.doesNotThrow(() => validateArtifactContent('<script type="text/typescript">const x: number = 1;</script>'))
})

test('substantial interactive drafts skip an unnecessary second generation, invalid drafts do not', () => {
  const draft = 'export default function App(){return <button onClick={()=>{}}>Run</button>} // ' + 'x'.repeat(4100)
  assert.equal(needsArtifactRender(draft), false)
  assert.equal(needsArtifactRender('export default function App( {return <button onClick={()=>{}}>Run</button>}'), true)
})

test('client runtime is valid JavaScript and worker construction failures do not jam the queue', async () => {
  const code = artifactClientRuntime('https://example.com')
  assert.doesNotThrow(() => new Script(code))
  const window: any = { addEventListener() {}, parent: {} }
  runInNewContext(code, { window, document: { addEventListener() {} }, Map, Set, Promise, setTimeout, clearTimeout, Blob, URL, Worker: class { constructor() { throw new Error('Worker blocked') } } })
  await assert.rejects(window.BackstoryArtifact.runPython('1+1'), /Worker blocked/)
  await assert.rejects(window.BackstoryArtifact.runPython('2+2'), /Worker blocked/)
  await assert.rejects(window.BackstoryArtifact.runPython('x'.repeat(100001)), /100,000/)
  await assert.rejects(window.BackstoryArtifact.runPython('1', () => {}), /JSON-compatible/)
  await assert.rejects(window.BackstoryArtifact.runPython('1', null, { timeoutMs: NaN }), /finite/)
})

test('inline Python is compiled but never executed during validation', async () => {
  await validateArtifactPython('<script type="text/python">raise RuntimeError("must not execute")</script>')
  await assert.rejects(validateArtifactPython('<script type="text/python">def broken(</script>'), /Python failed validation/)
})

test('the artifact compute worker executes actual Python and serializes dictionaries', async () => {
  const replies: any[] = []
  const phases: string[] = []
  const self: any = { postMessage: (value: any) => { if (!value.phase) replies.push(value); else phases.push(value.phase) } }
  runInNewContext(readFileSync('public/vendor/artifact-python-worker.js', 'utf8'), {
    self, importScripts() {}, loadPyodide: () => loadPyodide({ stdout() {}, stderr() {} }),
  })
  await self.onmessage({ data: { id: 1, protocol: 2, code: '{"mean": sum(input["values"])/len(input["values"])}', input: { values: [10, 20, 30] }, origin: 'https://example.com' } })
  assert.deepEqual(phases, ['loading-runtime', 'loading-packages', 'executing'])
  assert.deepEqual(JSON.parse(JSON.stringify(replies[0])), { id: 1, result: { mean: 20 } })
  await self.onmessage({ data: { id: 2, code: '1/0', input: {}, origin: 'https://example.com' } })
  assert.equal(phases.length, 3, 'legacy clients receive only their final result, never protocol-v2 progress')
  assert.match(replies[1].error, /ZeroDivisionError/)
  await self.onmessage({ data: { id: 3, code: 'qa_legacy = 21\nprint("inline one")', inlineSession: true, origin: 'https://example.com' } })
  assert.equal(replies[2].stdout, 'inline one\n')
  await self.onmessage({ data: { id: 4, code: 'qa_legacy * 2', inlineSession: true, origin: 'https://example.com' } })
  assert.equal(replies[3].result, 42)
  await self.onmessage({ data: { id: 5, code: 'qa_legacy', origin: 'https://example.com' } })
  assert.match(replies[4].error, /NameError/)
  await self.onmessage({ data: { id: 6, code: 'print("x" * 100000)', origin: 'https://example.com' } })
  assert.equal(replies[5].stdout.length, 65536)
})
