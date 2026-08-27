import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, render, cleanup, screen, waitFor } from '@testing-library/react'
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
  shadowPairCapHit: false,
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
  // The first fetch resolving is earlier than React committing the report and
  // installing the report-dependent interval. Wait for that committed UI, not
  // merely the fetch counter, before advancing the mocked clock.
  await screen.findByText(/status unknown/i)
  assert.equal(calls, 1)

  await act(async () => { t.mock.timers.tick(15_000) })
  // Generous real-time bound: this only waits on a promise microtask chain
  // (fetch stub -> setState -> rerender), but the full suite runs ~110 test
  // files concurrently across 10 cores, and CPU contention at that scale can
  // push that chain past a tight timeout even though the logic is correct —
  // confirmed by 5/5 clean runs of this file in isolation.
  await waitFor(() => assert.equal(calls, 2), { timeout: 8000 })
})

test('benchRunning: true still renders "bench running" and polls', async () => {
  stubModelsApi(true)
  render(<ModelsPanel days={30} />)

  await screen.findByText(/bench running/i)
})

/**
 * Sampling disclosure: bench's mean is over 3 judge samples per fixture,
 * shadow's is a single judge sample per pair — different sample sizes that
 * must never be read as the same strength of evidence. Plain-English labels
 * next to each heading, not a shared "score" word doing both jobs silently.
 */
test('bench and shadow headings disclose their different sample depths', async () => {
  stubModelsApi(null)
  render(<ModelsPanel days={30} />)

  await screen.findByText(/mean of 3 judge samples/i)
  await screen.findByText(/single judge sample/i)
})

test('a capped shadow-pair window says so instead of silently showing a partial picture', async () => {
  globalThis.fetch = (async (input: unknown) => {
    if (typeof input === 'string' && input.includes('/api/admin/models')) {
      return { ok: true, json: async () => ({ ...baseReport, benchRunning: null, shadowPairCapHit: true }) } as unknown as Response
    }
    return { ok: false, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  render(<ModelsPanel days={30} />)

  await screen.findByText(/more shadow pairs than fit/i)
})
