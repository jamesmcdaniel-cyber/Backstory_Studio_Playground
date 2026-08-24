import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '@/lib/server/api-handler'
import { deadLetterFromFlowJob, isDeterministicUserFailure, type FlowDeadLetterDeps } from '../flow-dead-letter'

/**
 * A dead-letter record is a promise to an operator: "a job failed for a reason
 * worth your attention, and its payload is kept so you can replay it." A flow
 * whose graph no longer validates — a step pointing at a deleted agent — keeps
 * neither half of that promise: the replay is guaranteed to fail the same way,
 * and the person who can fix it is the flow's owner, who already sees the
 * message on the run. Parking it anyway is what put non-incidents in the
 * queue-plane alert (see queue-watch.ts).
 */

const jobLike = (data: Record<string, unknown> = {}) =>
  ({ id: '7', name: 'execute-flow', data }) as never

function harness() {
  const parked: unknown[] = []
  const terminalized: unknown[] = []
  const captured: unknown[] = []
  const deps = {
    db: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          flowRun: {
            updateMany: async (args: unknown) => {
              terminalized.push(args)
              return { count: 1 }
            },
          },
          flowRunStep: { updateMany: async () => ({}) },
        }),
    },
    createQueue: (() => ({
      add: async (_name: string, data: unknown) => {
        parked.push(data)
        return { id: '1' }
      },
    })) as never,
    logger: { error: () => {}, warn: () => {} } as never,
    capture: ((error: unknown) => {
      captured.push(error)
    }) as never,
  } as unknown as FlowDeadLetterDeps
  return { deps, parked, terminalized, captured }
}

/** node:test has no microtask barrier of its own — the handler is fire-and-forget. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('isDeterministicUserFailure', () => {
  test('a flow that no longer validates is the flow owner’s problem, not an operator’s', () => {
    assert.equal(
      isDeterministicUserFailure(new ApiError('Priority Matrix uses an agent that is not available.', 400, 'FLOW_VALIDATION_ERROR')),
      true,
    )
  })
  test('a dependency drift is NOT — the payload is replayable once the fleets agree', () => {
    assert.equal(isDeterministicUserFailure(new ApiError('config changed', 409, 'FLOW_DEPENDENCY_DRIFT')), false)
  })
  test('an ordinary crash is not', () => {
    assert.equal(isDeterministicUserFailure(new Error('ECONNRESET')), false)
  })
})

describe('deadLetterFromFlowJob', () => {
  test('parks an ordinary failure and reports it', async () => {
    const { deps, parked, terminalized, captured } = harness()
    deadLetterFromFlowJob('flow-execution', deps)(jobLike({ flowRunId: 'run-1', organizationId: 'org-1' }), new Error('boom'))
    await settle()
    assert.equal(parked.length, 1)
    assert.equal(terminalized.length, 1, 'the run still stops saying running')
    assert.equal(captured.length, 1)
  })

  test('a validation failure terminalizes the run but parks nothing', async () => {
    const { deps, parked, terminalized, captured } = harness()
    deadLetterFromFlowJob('flow-execution', deps)(
      jobLike({ flowRunId: 'run-2', organizationId: 'org-1' }),
      new ApiError('Priority Matrix uses an agent that is not available. (+3 more)', 400, 'FLOW_VALIDATION_ERROR'),
    )
    await settle()
    assert.equal(terminalized.length, 1, 'the run must still be terminalized — that is what the user sees')
    assert.equal(parked.length, 0, 'nothing for an operator to replay or triage')
    assert.equal(captured.length, 0, 'and nothing to page anyone about')
  })
})
