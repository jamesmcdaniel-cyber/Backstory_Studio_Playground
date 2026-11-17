import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { terminalizeDeadLetteredExecution, type DeadLetterDeps } from '../dead-letter'
import { DEAD_LETTER_CANCELLED_ERROR, terminalizeDeadLetteredFlowRun, type FlowDeadLetterDeps } from '../flow-dead-letter'

/**
 * A dead-lettered run used to end with a bare status write: no owner
 * notification, a Slack placeholder saying "is on it…" forever, approvals it
 * left pending still approvable, no flow.failed signal, no error workflow, no
 * parent subflow woken. The follow-up hook does all that — but only for a row
 * THIS call actually moved, or a run that settled on its own would be
 * followed up twice.
 */

const quiet = { error: () => {}, warn: () => {} } as never

function agentDeps(count: number) {
  const followed: string[] = []
  const deps: DeadLetterDeps = {
    db: { agentExecution: { updateMany: async () => ({ count }) } },
    createQueue: (() => ({ add: async () => ({}) })) as never,
    logger: quiet,
    capture: (() => {}) as never,
    onTerminalized: async (executionId) => {
      followed.push(executionId)
    },
  }
  return { deps, followed }
}

describe('agent dead-letter follow-up', () => {
  test('a run this call failed is followed up once', async () => {
    const { deps, followed } = agentDeps(1)
    await terminalizeDeadLetteredExecution({ queue: 'q', executionId: 'exec-1', data: {}, error: 'boom' }, deps)
    assert.deepEqual(followed, ['exec-1'])
  })

  test('a run that already settled on its own is left alone', async () => {
    const { deps, followed } = agentDeps(0)
    await terminalizeDeadLetteredExecution({ queue: 'q', executionId: 'exec-1', data: {}, error: 'boom' }, deps)
    assert.deepEqual(followed, [])
  })

  test('a follow-up failure never throws at the worker', async () => {
    const { deps } = agentDeps(1)
    deps.onTerminalized = async () => {
      throw new Error('notify down')
    }
    await terminalizeDeadLetteredExecution({ queue: 'q', executionId: 'exec-1', data: {}, error: 'boom' }, deps)
  })
})

function flowDeps(counts: { running: number; cancelling: number }) {
  const writes: Array<{ where: { status: string }; data: { status: string; error: string } }> = []
  const steps: Array<{ data: { status: string } }> = []
  const followed: Array<[string, string]> = []
  const tx = {
    flowRun: {
      updateMany: async (args: { where: { status: string }; data: { status: string; error: string } }) => {
        writes.push(args)
        return { count: args.where.status === 'running' ? counts.running : counts.cancelling }
      },
    },
    flowRunStep: {
      updateMany: async (args: { data: { status: string } }) => {
        steps.push(args)
        return {}
      },
    },
  }
  const deps = {
    db: { ...tx, $transaction: async (fn: (handle: unknown) => Promise<unknown>) => fn(tx) },
    createQueue: (() => ({ add: async () => ({}) })) as never,
    logger: quiet,
    capture: (() => {}) as never,
    onTerminalized: async (flowRunId: string, status: string) => {
      followed.push([flowRunId, status])
    },
  } as unknown as FlowDeadLetterDeps
  return { deps, writes, steps, followed }
}

describe('flow dead-letter follow-up', () => {
  test('a running run is failed and followed up as failed', async () => {
    const { deps, followed, steps } = flowDeps({ running: 1, cancelling: 0 })
    await terminalizeDeadLetteredFlowRun({ queue: 'q', flowRunId: 'run-1', data: {}, error: 'boom' }, deps)
    assert.deepEqual(followed, [['run-1', 'failed']])
    assert.equal(steps[0].data.status, 'failed')
  })

  test('a cancelling run whose worker died resolves to cancelled, not cancelling forever', async () => {
    const { deps, writes, followed, steps } = flowDeps({ running: 0, cancelling: 1 })
    await terminalizeDeadLetteredFlowRun({ queue: 'q', flowRunId: 'run-1', data: {}, error: 'boom' }, deps)
    assert.equal(writes[1].where.status, 'cancelling')
    assert.equal(writes[1].data.status, 'cancelled')
    assert.equal(writes[1].data.error, DEAD_LETTER_CANCELLED_ERROR)
    assert.equal(steps[0].data.status, 'cancelled')
    assert.deepEqual(followed, [['run-1', 'cancelled']])
  })

  test('a run in neither state (already settled, or rolled back to waiting) is untouched', async () => {
    const { deps, followed, steps } = flowDeps({ running: 0, cancelling: 0 })
    await terminalizeDeadLetteredFlowRun({ queue: 'q', flowRunId: 'run-1', data: {}, error: 'boom' }, deps)
    assert.deepEqual(followed, [])
    assert.equal(steps.length, 0)
  })
})
