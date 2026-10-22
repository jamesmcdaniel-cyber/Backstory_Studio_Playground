import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlowCode } from '../code-runner'

/**
 * Its own file, so the interpreter is cold: loading Pyodide takes longer than
 * this run's whole budget, and must not count against it.
 */
test('a cold interpreter load is not charged to the first run’s time budget', async () => {
  const { output } = await runFlowCode({ language: 'python', mode: 'all', code: 'return input + 1', input: 1, timeoutMs: 1_000 })
  assert.equal(output, 2)
})
