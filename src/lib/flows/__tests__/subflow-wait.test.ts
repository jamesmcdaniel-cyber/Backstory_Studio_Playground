import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeSubflowWait, subflowWaitingStatus } from '../subflow'

// The parent of a paused subflow used to hard-code kind 'input', so its Runs
// panel offered a reply box for a child paused on an approval or a timer —
// where a typed reply can only fail.

test('a child asking a question keeps the reply box, prefixed with its name', () => {
  const wait = describeSubflowWait({ waiting: { kind: 'input', question: 'Which region?' } }, 'Enrich')
  assert.deepEqual(wait, { kind: 'input', question: 'Enrich: Which region?' })
  assert.equal(subflowWaitingStatus(wait.kind), 'waiting_for_input')
})

test('a child paused on an approval carries the approval kind up', () => {
  const wait = describeSubflowWait({ waiting: { kind: 'approval', approvalId: 'ap1', question: 'Approve send?' } }, 'Send')
  assert.equal(wait.kind, 'approval')
  assert.match(wait.question, /waiting for an approval decision/)
  // The child's approval id stays on the child: the parent must not look
  // paused on an approval of its own (settleRunApprovals would supersede it).
  assert.equal((wait as Record<string, unknown>).approvalId, undefined)
  assert.equal(subflowWaitingStatus(wait.kind), 'waiting_for_approval')
})

test('timer, webhook and external waits carry their kind and timing', () => {
  const timer = describeSubflowWait({ waiting: { kind: 'timer', resumeAt: '2026-11-18T09:00:00.000Z' } }, 'Later')
  assert.equal(timer.kind, 'timer')
  assert.equal(timer.resumeAt, '2026-11-18T09:00:00.000Z')
  const hook = describeSubflowWait({ waiting: { kind: 'webhook', timeoutAt: '2026-11-19T00:00:00.000Z' } }, 'Callback')
  assert.equal(hook.kind, 'webhook')
  assert.equal(hook.timeoutAt, '2026-11-19T00:00:00.000Z')
  assert.equal(subflowWaitingStatus('external'), 'waiting_for_external')
  assert.equal(subflowWaitingStatus('timer'), 'waiting_for_input')
})

test('a legacy child row with no pause reason reads as a question, as before', () => {
  assert.deepEqual(describeSubflowWait(null, 'Old'), { kind: 'input', question: '"Old" paused to ask for input.' })
  assert.deepEqual(describeSubflowWait({ waiting: {} }, 'Old'), { kind: 'input', question: '"Old" paused to ask for input.' })
})
