import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlowCode } from '../code-runner'

test('runs JavaScript with JSON input and context', async () => {
  const output = await runFlowCode({
    language: 'javascript',
    mode: 'all',
    code: 'return { total: input.values.reduce((sum, value) => sum + value, 0), runId: context.run.id };',
    input: { values: [2, 3, 5] },
    context: { run: { id: 'run-1' } },
  })
  assert.deepEqual(output, { total: 10, runId: 'run-1' })
})

test('runs Python once for each item and preserves order', async () => {
  const output = await runFlowCode({
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
    /Code generation from strings disallowed|process is not defined/,
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
