import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * A `mode: 'each'` code step used to be bounded only per item: 1,000 items at
 * the 30 s per-item maximum was eight hours of sandbox time from one step.
 * The step now carries an outer budget (FLOW_STEP_MAX_MS, or items × per-item
 * timeout when that is smaller) and fails with a message that says where it
 * stopped. Set before import: the budget is read once at module load.
 */
process.env.FLOW_STEP_MAX_MS = '1500'

const BUSY_400_MS = 'const end = Date.now() + 400; while (Date.now() < end) {} return input;'

test('a per-item loop stops at the step budget and names how far it got', async () => {
  const { runFlowCode, FLOW_STEP_MAX_MS } = await import('../code-runner')
  assert.equal(FLOW_STEP_MAX_MS, 1500)
  const started = Date.now()
  await assert.rejects(
    runFlowCode({
      language: 'javascript',
      mode: 'each',
      code: BUSY_400_MS,
      input: Array.from({ length: 20 }, (_, index) => index),
      timeoutMs: 5_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /exceeded its overall time budget of 2s after \d+ of 20 items/)
      return true
    },
  )
  // Well short of 20 × 400 ms: the loop was cut, not run to completion.
  assert.ok(Date.now() - started < 6_000, 'the loop must stop near the budget, not run every item')
})

test('a loop that fits the budget still runs every item', async () => {
  const { runFlowCode } = await import('../code-runner')
  const { output } = await runFlowCode({
    language: 'javascript',
    mode: 'each',
    code: 'return input * 2;',
    input: [1, 2, 3],
  })
  assert.deepEqual(output, [2, 4, 6])
})
