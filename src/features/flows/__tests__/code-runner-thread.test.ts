import test from 'node:test'
import assert from 'node:assert/strict'
import { runFlowCode, validatePythonSyntax, warmPythonRuntime } from '../code-runner'

/**
 * Python runs on its own thread. On the Fly worker it used to run on the event
 * loop: a dataset step (up to 5 minutes) froze the heartbeat, every other job's
 * model stream and the health check for as long as it ran.
 */

const BUSY_PYTHON = 'total = 0\nfor i in range(30000000):\n    total += i\nreturn total'

test('a busy Python step leaves the event loop free', async () => {
  await warmPythonRuntime()
  let ticks = 0
  const ticker = setInterval(() => { ticks += 1 }, 20)
  const started = Date.now()
  try {
    const { output } = await runFlowCode({ language: 'python', mode: 'all', code: BUSY_PYTHON, input: null, timeoutMs: 30_000 })
    assert.equal(typeof output, 'number')
  } finally {
    clearInterval(ticker)
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed > 300, `the step should take a while to prove anything (took ${elapsed} ms)`)
  // A blocked loop fires at most once after the step; a free one ~elapsed/20.
  assert.ok(ticks >= Math.floor(elapsed / 20 / 3), `${ticks} ticks in ${elapsed} ms: the event loop was blocked`)
})

test('a Python step past its deadline is stopped, and the next run still works', async () => {
  await assert.rejects(
    runFlowCode({ language: 'python', mode: 'all', code: 'while True:\n    pass', input: null, timeoutMs: 1_000 }),
    /timed out after 1s/,
  )
  const { output } = await runFlowCode({ language: 'python', mode: 'all', code: 'return input + 1', input: 41 })
  assert.equal(output, 42)
})

test('a run stuck in native code loses its thread after the grace period, and the next run gets a fresh one', async () => {
  // sum() over a range loops in C without checking for the interrupt signal.
  const started = Date.now()
  await assert.rejects(
    runFlowCode({ language: 'python', mode: 'all', code: 'return sum(range(10 ** 13))', input: null, timeoutMs: 1_000 }),
    /timed out after 1s/,
  )
  assert.ok(Date.now() - started < 20_000, 'the stuck run must be cut off, not awaited')
  const { output } = await runFlowCode({ language: 'python', mode: 'all', code: 'return input * 2', input: 21 })
  assert.equal(output, 42)
})

test('syntax checks share the Python thread', async () => {
  await validatePythonSyntax('x = 1\nprint(x)')
  await assert.rejects(validatePythonSyntax('def broken(:\n    pass'), /SyntaxError|invalid syntax/)
})
