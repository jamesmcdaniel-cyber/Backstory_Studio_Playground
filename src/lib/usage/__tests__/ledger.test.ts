import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recordLlmCall } from '@/lib/usage/ledger'

/**
 * Unit-level coverage with a fake prisma client (no DB): the detail row and
 * both rollup increments must land inside ONE `$transaction`, so a mid-write
 * crash can never leave a detail row on record with no matching bump to its
 * parent's total. The DB-backed sibling (ledger.db.test.ts) covers the real
 * write path end to end; this one pins the transactional shape.
 */
describe('recordLlmCall', () => {
  type FakeTx = {
    llmCall: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> }
    agentExecution: { update: (args: unknown) => Promise<unknown> }
    flowRun: { update: (args: unknown) => Promise<unknown> }
  }

  function fakeClient() {
    const calls: string[] = []
    let transactionCount = 0
    const tx: FakeTx = {
      llmCall: {
        create: async (args) => {
          calls.push('llmCall.create')
          return args.data
        },
      },
      agentExecution: {
        update: async () => {
          calls.push('agentExecution.update')
          return {}
        },
      },
      flowRun: {
        update: async () => {
          calls.push('flowRun.update')
          return {}
        },
      },
    }
    return {
      calls,
      get transactionCount() {
        return transactionCount
      },
      $transaction: async <T>(fn: (tx: FakeTx) => Promise<T>) => {
        transactionCount += 1
        return fn(tx)
      },
    }
  }

  it('writes the detail row and both rollup increments inside a single $transaction call', async () => {
    const client = fakeClient()
    await recordLlmCall(
      {
        organizationId: 'org-1',
        agentExecutionId: 'exec-1',
        flowRunId: 'run-1',
        surface: 'flow_ai',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        usage: { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 100 },
      },
      client,
    )

    assert.equal(client.transactionCount, 1, 'exactly one $transaction call — not three separate writes')
    assert.deepEqual(client.calls, ['llmCall.create', 'agentExecution.update', 'flowRun.update'])
  })

  it('skips both rollup increments for a zero-cost (unknown-model) call, but still creates the detail row', async () => {
    const client = fakeClient()
    await recordLlmCall(
      {
        organizationId: 'org-1',
        agentExecutionId: 'exec-1',
        flowRunId: 'run-1',
        surface: 'structured',
        provider: 'anthropic',
        model: 'model-from-the-future',
        usage: { inputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
      },
      client,
    )

    assert.equal(client.transactionCount, 1)
    assert.deepEqual(client.calls, ['llmCall.create'])
  })

  it('never throws when the transaction itself fails — the ledger is best-effort', async () => {
    const client = {
      $transaction: async () => {
        throw new Error('connection reset')
      },
    }
    await assert.doesNotReject(
      recordLlmCall(
        {
          organizationId: 'org-1',
          flowRunId: 'run-1',
          flowRunStepId: 'step-1',
          surface: 'flow_ai',
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
        },
        client,
      ),
    )
  })
})
