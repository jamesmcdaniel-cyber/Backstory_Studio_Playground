import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup, screen, waitFor } from '@testing-library/react'
import { ModelsPanel } from '@/app/admin/users/models-panel'

/**
 * benchRunning is a tri-state (`true` / `false` / `null` — "could not check",
 * from an unreachable queue or inline mode). Silently treating `null` as
 * "idle" is how an operator starts a second bench on top of one that is
 * actually still running, so the panel must render it as its own state AND
 * keep the quiet poll alive rather than settling.
 */

const realFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

const baseReport = {
  days: 30,
  total: { costUsd: 0, calls: 0 },
  dataSince: null,
  models: [],
  bench: [],
  benchDetail: [],
  shadow: [],
  benchable: [],
  shadowSampling: null,
  limits: { frontierClaudeRunsPerDay: 10, claudeRunsPerDay: 50 },
}

function stubModelsApi(benchRunning: boolean | null, onFetch?: () => void) {
  globalThis.fetch = (async (input: unknown) => {
    onFetch?.()
    if (typeof input === 'string' && input.includes('/api/admin/models')) {
      return { ok: true, json: async () => ({ ...baseReport, benchRunning }) } as unknown as Response
    }
    return { ok: false, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
}

test('benchRunning: null renders as "status unknown", not idle', async () => {
  stubModelsApi(null)
  render(<ModelsPanel days={30} />)

  await screen.findByText(/status unknown/i)
  assert.equal(screen.queryByText(/^run bench$/i), null, 'must not read as idle while unknown')
  assert.equal(screen.queryByText(/bench running/i), null, 'must not claim it is running either — that is a fact, not a guess')
})

test('benchRunning: null keeps the quiet poll alive', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  stubModelsApi(null, () => { calls += 1 })

  render(<ModelsPanel days={30} />)
  await waitFor(() => assert.equal(calls, 1))

  t.mock.timers.tick(15_000)
  await waitFor(() => assert.equal(calls, 2), { timeout: 2000 })
})

test('benchRunning: true still renders "bench running" and polls', async () => {
  stubModelsApi(true)
  render(<ModelsPanel days={30} />)

  await screen.findByText(/bench running/i)
})
