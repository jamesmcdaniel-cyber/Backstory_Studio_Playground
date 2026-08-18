import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRunWaiting, deriveRunWaitingAll, chooseWaitingReply } from '../run-waiting'

test('returns null for non-waiting runs even if a step is waiting', () => {
  assert.equal(deriveRunWaiting('succeeded', [{ nodeId: 'a', status: 'waiting' }]), null)
  assert.equal(deriveRunWaiting('failed', []), null)
  assert.equal(deriveRunWaiting('running', [{ nodeId: 'a', status: 'running' }]), null)
})

test('returns null when a waiting run has no waiting step', () => {
  assert.equal(deriveRunWaiting('waiting', [{ nodeId: 'a', status: 'succeeded' }]), null)
})

test('derives an input pause with its question', () => {
  const steps = [
    { nodeId: 'a', status: 'succeeded', output: 'done' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'Which account?' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'Which account?' })
})

test('derives an approval pause', () => {
  const steps = [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'approval', approvalId: 'ap_1' } } }]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'approval', question: undefined })
})

test('defaults to input when the waiting info is missing or malformed', () => {
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: null }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: 'a summary string' }]), { nodeId: 'b', kind: 'input', question: undefined })
  assert.deepEqual(deriveRunWaiting('waiting', [{ nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'bogus' } } }]), { nodeId: 'b', kind: 'input', question: undefined })
})

test('picks the latest waiting step when multiple are waiting', () => {
  const steps = [
    { nodeId: 'a', status: 'waiting', output: { waiting: { kind: 'approval' } } },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'q' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'q' })
})

test('resume then re-pause: the resolved old row is ignored, the new pause wins', () => {
  // First run paused on node a; resume resolved that row to 'resumed', the
  // re-run created new rows, and a later node b paused again.
  const steps = [
    { nodeId: 'a', status: 'resumed', output: { waiting: { kind: 'input', question: 'old question' } } },
    { nodeId: 'a', status: 'succeeded', output: 'answered' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'input', question: 'new question' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'input', question: 'new question' })
})

test('stale unresolved waiting row (legacy run): the latest pause still wins', () => {
  // Legacy resumes never resolved the old waiting row — both rows say waiting,
  // but the later one (higher order) is the live pause.
  const steps = [
    { nodeId: 'a', status: 'waiting', output: { waiting: { kind: 'input', question: 'old question' } } },
    { nodeId: 'a', status: 'succeeded', output: 'answered' },
    { nodeId: 'b', status: 'waiting', output: { waiting: { kind: 'approval', approvalId: 'ap_2' } } },
  ]
  assert.deepEqual(deriveRunWaiting('waiting', steps), { nodeId: 'b', kind: 'approval', question: undefined })
})

// ── Several pauses at once (a loop that ran its iterations concurrently) ────

test('deriveRunWaitingAll lists every paused iteration with its own step key', () => {
  const steps = [
    { nodeId: 'loop', status: 'waiting' }, // the container row: display only
    { nodeId: 'review#0', status: 'waiting', output: { waiting: { kind: 'input', question: 'Approve item 1?' } } },
    { nodeId: 'review#1', status: 'waiting', output: { waiting: { kind: 'input', question: 'Approve item 2?' } } },
    { nodeId: 'review#2', status: 'waiting', output: { waiting: { kind: 'input', question: 'Approve item 3?' } } },
  ]
  const all = deriveRunWaitingAll('waiting', steps)
  assert.deepEqual(all.map((entry) => entry.nodeId), ['review#0', 'review#1', 'review#2'])
  assert.deepEqual(all.map((entry) => entry.stepKey), ['review#0', 'review#1', 'review#2'])
  assert.deepEqual(all.map((entry) => entry.iteration), [1, 2, 3])
  assert.deepEqual(all.map((entry) => entry.question), ['Approve item 1?', 'Approve item 2?', 'Approve item 3?'])
})

test('deriveRunWaitingAll collapses a stale row and the live row for the same step', () => {
  const steps = [
    { nodeId: 'ask', status: 'waiting', output: { waiting: { kind: 'input', question: 'old' } } },
    { nodeId: 'ask', status: 'waiting', output: { waiting: { kind: 'input', question: 'new' } } },
  ]
  assert.deepEqual(deriveRunWaitingAll('waiting', steps), [{ nodeId: 'ask', kind: 'input', question: 'new' }])
})

test('deriveRunWaitingAll is empty unless the run itself is waiting', () => {
  assert.deepEqual(deriveRunWaitingAll('running', [{ nodeId: 'a', status: 'waiting' }]), [])
  assert.deepEqual(deriveRunWaitingAll('waiting', [{ nodeId: 'a', status: 'succeeded' }]), [])
})

test('deriveRunWaitingAll keeps legacy rows that never recorded a pause reason', () => {
  assert.deepEqual(deriveRunWaitingAll('waiting', [{ nodeId: 'a', status: 'waiting' }]), [
    { nodeId: 'a', kind: 'input', question: undefined },
  ])
})

test('deriveRunWaiting still answers with a single pause, now carrying its step key', () => {
  const steps = [{ nodeId: 'review#2', status: 'waiting', output: { waiting: { kind: 'input', question: 'q' } } }]
  assert.deepEqual(deriveRunWaiting('waiting', steps), {
    nodeId: 'review#2',
    kind: 'input',
    question: 'q',
    stepKey: 'review#2',
    iteration: 3,
  })
})

// ── Routing one reply to the pause it answers ──────────────────────────────

test('a keyed reply resolves exactly its own iteration, never the last one', () => {
  const pending = [{ nodeId: 'review#0' }, { nodeId: 'review#1' }, { nodeId: 'review#2' }]
  for (const key of ['review#0', 'review#1', 'review#2']) {
    const routed = chooseWaitingReply(pending, key)
    assert.deepEqual(routed, { target: { nodeId: key } })
  }
})

test('an un-keyed reply is refused (not guessed) while several reviews are waiting', () => {
  const routed = chooseWaitingReply([{ nodeId: 'review#0' }, { nodeId: 'review#1' }])
  assert.ok(routed && 'error' in routed)
  assert.equal(routed.code, 'FLOW_REPLY_AMBIGUOUS')
  assert.match(routed.error, /2 reviews at once/)
})

test('an un-keyed reply still resolves the single pause it can only mean', () => {
  assert.deepEqual(chooseWaitingReply([{ nodeId: 'ask' }]), { target: { nodeId: 'ask' } })
  assert.deepEqual(chooseWaitingReply([{ nodeId: 'review#1' }]), { target: { nodeId: 'review#1' } })
})

test('a reply for a pause that already moved on is refused with its own code', () => {
  const routed = chooseWaitingReply([{ nodeId: 'review#1' }], 'review#0')
  assert.ok(routed && 'error' in routed)
  assert.equal(routed.code, 'FLOW_REPLY_TARGET_GONE')
})

test('no pause at all routes to nothing, leaving the caller to carry on', () => {
  assert.equal(chooseWaitingReply([], 'review#0'), null)
  assert.equal(chooseWaitingReply([]), null)
})
