import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlowCode } from '../code-runner'

test('runs JavaScript with JSON input and context', async () => {
  const { output } = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'return { total: input.values.reduce((sum, value) => sum + value, 0), runId: context.run.id };',
    input: { values: [2, 3, 5] },
    context: { run: { id: 'run-1' } },
  })
  assert.deepEqual(output, { total: 10, runId: 'run-1' })
})

test('runs async JavaScript inside QuickJS/WASM', async () => {
  const { output } = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'const value = await Promise.resolve(input + 1); return value * 2;',
    input: 20,
  })
  assert.equal(output, 42)
})

test('runs Python once for each item and preserves order', async () => {
  const { output } = await runFlowCode({
    language: 'python',
    mode: 'each',
    code: 'return {"value": input * 2, "index": context["index"]}',
    input: [3, 1, 4],
  })
  assert.deepEqual(output, [
    { value: 6, index: 0 },
    { value: 2, index: 1 },
    { value: 8, index: 2 },
  ])
})

test('captures JavaScript console output as logs', async () => {
  const { output, logs } = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'console.log("hello", { n: 1 }); console.warn("careful"); return input;',
    input: { ok: true },
  })
  assert.deepEqual(output, { ok: true })
  assert.deepEqual(logs, ['log: hello {"n":1}', 'warn: careful'])
})

test('captures Python print output as logs', async () => {
  const { output, logs } = await runFlowCode({
    language: 'python',
    mode: 'all',
    code: 'print("hello", input["n"])\nreturn input',
    input: { n: 7 },
  })
  assert.deepEqual(output, { n: 7 })
  assert.deepEqual(logs, ['hello 7'])
})

test('prefixes per-item logs in each mode', async () => {
  const { logs } = await runFlowCode({
    language: 'javascript',
    mode: 'each',
    code: 'console.log("row", input); return input;',
    input: [10, 20],
  })
  assert.deepEqual(logs, ['[item 0] log: row 10', '[item 1] log: row 20'])
})

test('marks a JavaScript log entry truncated instead of silently cutting it', async () => {
  const { logs } = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'console.log("x".repeat(2010)); return input;',
    input: null,
  })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^log: x+\n… \[truncated 15 chars\]$/)
})

test('marks a Python log entry truncated instead of silently cutting it', async () => {
  const { logs } = await runFlowCode({
    language: 'python',
    mode: 'all',
    code: 'print("y" * 2010)\nreturn input',
    input: null,
  })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /^y+\n… \[truncated 10 chars\]$/)
})

test('appends an explicit marker once the 200-entry log cap is hit', async () => {
  const { logs } = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'for (let i = 0; i < 210; i++) console.log(i); return null;',
    input: null,
  })
  assert.equal(logs.length, 201)
  assert.equal(logs[200], '… [log truncated at 200 entries]')
})

test('appends an explicit marker once the 200-entry log cap is hit across each-mode items', async () => {
  const { logs } = await runFlowCode({
    language: 'javascript',
    mode: 'each',
    code: 'console.log("row", input); return input;',
    input: Array.from({ length: 210 }, (_, i) => i),
  })
  assert.equal(logs.length, 201)
  assert.equal(logs[200], '… [log truncated at 200 entries]')
})

test('blocks privileged Python capabilities', async () => {
  await assert.rejects(
    runFlowCode({
      language: 'python',
      mode: 'all',
      code: 'import os\nreturn os.listdir("/")',
      input: null,
    }),
    /Imports.*not available/,
  )
})

test('does not expose host constructors to JavaScript input', async () => {
  await assert.rejects(
    runFlowCode({
      language: 'javascript',
      mode: 'all',
      code: 'return input.constructor.constructor("return process")();',
      input: { safe: true },
    }),
    /Code generation from strings disallowed|['"]?process['"]? is not defined/,
  )
})

test('terminates JavaScript that exceeds its deadline', async () => {
  await assert.rejects(
    runFlowCode({
      language: 'javascript',
      mode: 'all',
      code: 'while (true) {}',
      input: null,
      timeoutMs: 1000,
    }),
    /timed out/,
  )
})

test('interrupts Python/WASM that exceeds its deadline', async () => {
  await assert.rejects(
    runFlowCode({
      language: 'python',
      mode: 'all',
      code: 'while True:\n    pass',
      input: null,
      timeoutMs: 1000,
    }),
    /timed out/,
  )
})
