import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { UnrecoverableError } from 'bullmq'
import { AgentRunRefusedError } from '@/lib/agents/run-errors'
import { AiEgressBlockedError } from '@/lib/security/pii-egress'
import { deadLetterFromJob, isDeterministicAgentFailure, isFinalAttempt, type DeadLetterDeps } from '../dead-letter'
import { deadLetterFromFlowJob, type FlowDeadLetterDeps } from '../flow-dead-letter'

/**
 * When a failed agent job becomes a dead letter, and what that does.
 *
 * Two regressions this pins. BullMQ emits `failed` after every attempt, so
 * attempt 1 of a two-attempt job used to park the job and page Sentry while
 * its retry was already queued. And a refusal no replay could change — the
 * losing side of two racing replies above all — used to be parked AND written
 * over the winning run's row as `failed`.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const job = (over: Record<string, unknown> = {}) =>
  ({ id: '7', name: 'resume-agent', data: { executionId: 'exec-1', organizationId: 'org-1' }, attemptsMade: 2, opts: { attempts: 2 }, ...over }) as never

function harness() {
  const updates: any[] = []
  const parked: unknown[] = []
  const captured: unknown[] = []
  const warnings: string[] = []
  const deps: DeadLetterDeps = {
    db: { agentExecution: { updateMany: async (args) => { updates.push(args); return { count: 1 } } } },
    createQueue: (() => ({ add: async (_name: string, data: unknown) => { parked.push(data); return { id: '1' } } })) as never,
    logger: { error: () => {}, warn: (message: string) => { warnings.push(message) } } as never,
    capture: ((error: unknown) => { captured.push(error) }) as never,
  }
  return { deps, updates, parked, captured, warnings }
}

describe('isFinalAttempt', () => {
  test('an attempt with a retry still to come is not final', () => {
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 2 } } as never), false)
  })
  test('the last attempt is final', () => {
    assert.equal(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 2 } } as never), true)
  })
  test('a job BullMQ already finished (an UnrecoverableError on attempt 1) is final', () => {
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 2 }, finishedOn: Date.now() } as never), true)
  })
  test('a job with no attempts option is single-shot', () => {
    assert.equal(isFinalAttempt({ attemptsMade: 1, opts: {} } as never), true)
  })
})

describe('isDeterministicAgentFailure', () => {
  test('the runtime’s typed refusals are deterministic', () => {
    for (const code of ['AGENT_UNAVAILABLE', 'TEMPLATE_COPY_GUARD', 'EXECUTION_MISMATCH', 'RESUME_WITHOUT_EXECUTION', 'NOT_AWAITING_REPLY', 'MONTHLY_BUDGET'] as const) {
      assert.equal(isDeterministicAgentFailure(new AgentRunRefusedError('x', code)), true, code)
    }
  })
  test('a typed refusal is also unrecoverable, so BullMQ does not spend its retry on it', () => {
    assert.ok(new AgentRunRefusedError('Agent not found or inactive', 'AGENT_UNAVAILABLE') instanceof UnrecoverableError)
  })
  test('the workspace AI opt-out is deterministic', () => {
    assert.equal(isDeterministicAgentFailure(new AiEgressBlockedError()), true)
  })
  test('an @artifact request with no executable artifact is deterministic', () => {
    assert.equal(
      isDeterministicAgentFailure(new Error('@artifact was requested, but the agent did not produce an executable artifact. Review the run and retry; no completed app is claimed.')),
      true,
    )
  })
  test('the provider rejecting a saved model id is deterministic', () => {
    const notFound = Object.assign(new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}'), { status: 404 })
    const badRequest = Object.assign(new Error('400 model: claude-nope is not a valid model'), { status: 400 })
    assert.equal(isDeterministicAgentFailure(notFound), true)
    assert.equal(isDeterministicAgentFailure(badRequest), true)
  })
  test('a 400 that is not about the model is not', () => {
    assert.equal(isDeterministicAgentFailure(Object.assign(new Error('400 messages: text content blocks must be non-empty'), { status: 400 })), false)
  })
  test('outages and crashes are not', () => {
    assert.equal(isDeterministicAgentFailure(Object.assign(new Error('529 overloaded'), { status: 529 })), false)
    assert.equal(isDeterministicAgentFailure(new Error('ECONNRESET')), false)
  })
})

describe('deadLetterFromJob', () => {
  test('a failed attempt with its retry queued does nothing at all', async () => {
    const { deps, updates, parked, captured } = harness()
    deadLetterFromJob('agent-execution', deps)(job({ attemptsMade: 1 }), new Error('ECONNRESET'))
    await settle()
    assert.deepEqual(updates, [])
    assert.deepEqual(parked, [])
    assert.deepEqual(captured, [])
  })

  test('the final attempt of an ordinary failure is terminalized, parked and reported', async () => {
    const { deps, updates, parked, captured } = harness()
    deadLetterFromJob('agent-execution', deps)(job(), new Error('ECONNRESET'))
    await settle()
    assert.deepEqual(updates[0].where, { id: 'exec-1', status: { in: ['pending', 'running'] } })
    assert.equal(parked.length, 1)
    assert.equal(captured.length, 1)
  })

  test('a deterministic refusal stops the run saying running but parks and reports nothing', async () => {
    const { deps, updates, parked, captured, warnings } = harness()
    deadLetterFromJob('agent-execution', deps)(job(), new AgentRunRefusedError('Agent not found or inactive', 'AGENT_UNAVAILABLE'))
    await settle()
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].where.status, { in: ['pending', 'running'] })
    assert.deepEqual(parked, [])
    assert.deepEqual(captured, [])
    assert.equal(warnings.length, 1)
  })

  test('the losing side of two racing replies never touches the winning run’s row', async () => {
    const { deps, updates, parked, captured } = harness()
    deadLetterFromJob('agent-execution', deps)(
      job({ attemptsMade: 1, finishedOn: Date.now() }),
      new AgentRunRefusedError('Execution is not waiting for input or approval', 'NOT_AWAITING_REPLY'),
    )
    await settle()
    assert.deepEqual(updates, [], 'the winner is running; a failure from the loser must not land on it')
    assert.deepEqual(parked, [])
    assert.deepEqual(captured, [])
  })

  test('an execution id that does not belong to the job’s tenant is never written', async () => {
    const { deps, updates } = harness()
    deadLetterFromJob('agent-execution', deps)(job(), new AgentRunRefusedError('Queued execution does not match this tenant and agent', 'EXECUTION_MISMATCH'))
    await settle()
    assert.deepEqual(updates, [])
  })
})

describe('deadLetterFromFlowJob — final attempt only', () => {
  test('a resume attempt with its retry queued does nothing', async () => {
    const terminalized: unknown[] = []
    const parked: unknown[] = []
    const deps = {
      db: {
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ flowRun: { updateMany: async (args: unknown) => { terminalized.push(args); return { count: 1 } } }, flowRunStep: { updateMany: async () => ({}) } }),
      },
      createQueue: (() => ({ add: async (_name: string, data: unknown) => { parked.push(data); return { id: '1' } } })) as never,
      logger: { error: () => {}, warn: () => {} } as never,
      capture: (() => {}) as never,
    } as unknown as FlowDeadLetterDeps
    const handler = deadLetterFromFlowJob('flow-execution', deps)
    handler({ id: '1', name: 'execute-flow', data: { flowRunId: 'run-1' }, attemptsMade: 1, opts: { attempts: 2 } } as never, new Error('boom'))
    await settle()
    assert.deepEqual(terminalized, [])
    assert.deepEqual(parked, [])

    handler({ id: '1', name: 'execute-flow', data: { flowRunId: 'run-1' }, attemptsMade: 2, opts: { attempts: 2 } } as never, new Error('boom'))
    await settle()
    assert.equal(terminalized.length, 1)
    assert.equal(parked.length, 1)
  })
})
