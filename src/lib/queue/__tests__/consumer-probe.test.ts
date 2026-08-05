import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumerVerdict, deadLetterVerdict } from '../consumer-probe'

const report = (queue: string, workers: number, waiting: number, active = 0) => ({ queue, workers, waiting, active })

test('all execution queues consumed → ok, nothing stranded', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 3, 0),
    report('scheduled-agent-execution', 3, 0),
    report('flow-execution', 3, 2, 1),
  ])
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.stranded, [])
})

test('a queue with zero consumers fails the verdict even while empty — the NEXT run would hang', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 2, 0),
    report('flow-execution', 0, 0),
  ])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.stranded, [], 'nothing waiting yet, so nothing stranded')
})

test('waiting jobs with zero consumers are reported as stranded — the acute alarm', () => {
  const verdict = consumerVerdict([
    report('agent-execution', 0, 1),
    report('flow-execution', 0, 2),
  ])
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.stranded, ['agent-execution', 'flow-execution'])
})

test('no reports (probe could not read the queues) → not ok', () => {
  assert.equal(consumerVerdict([]).ok, false)
})

test('dead-letter verdict totals waiting jobs across DLQs and names the non-empty ones', () => {
  const verdict = deadLetterVerdict([
    { queue: 'agent-dead-letter', waiting: 0 },
    { queue: 'flow-dead-letter', waiting: 3 },
    { queue: 'template-generation-dead-letter', waiting: 1 },
  ])
  assert.equal(verdict.total, 4)
  assert.deepEqual(verdict.queues, ['flow-dead-letter', 'template-generation-dead-letter'])
})

test('empty dead-letter queues → zero total, no queues named', () => {
  const verdict = deadLetterVerdict([
    { queue: 'agent-dead-letter', waiting: 0 },
    { queue: 'flow-dead-letter', waiting: 0 },
  ])
  assert.equal(verdict.total, 0)
  assert.deepEqual(verdict.queues, [])
})
