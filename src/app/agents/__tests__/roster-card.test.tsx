import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { RosterCard } from '../roster-card'

const baseProps = {
  seed: 'agent-1',
  name: 'Renewals watcher',
  role: null,
  roleLoading: false,
  presence: 'ready' as const,
  onOpen: () => {},
  onConfigure: () => {},
  configureLabel: 'Configure Renewals watcher',
}

test('a fully measured card shows its exact run count with no approximation marker', () => {
  const { getByText, queryByText } = render(
    React.createElement(RosterCard, {
      ...baseProps,
      stats: { runs: 12, completed: 10, failed: 2, approximateRuns: 0 },
    }),
  )
  assert.ok(getByText('12'))
  assert.equal(queryByText(/~/), null)
  cleanup()
})

test('a card carrying approximate (counter-only) runs renders "~N runs" rather than an exact number', () => {
  const { getByText } = render(
    React.createElement(RosterCard, {
      ...baseProps,
      stats: { runs: 0, completed: 0, failed: 0, approximateRuns: 42 },
    }),
  )
  assert.ok(getByText('~42'))
  cleanup()
})

test('a mixed card totals measured + approximate runs under the "~" marker', () => {
  const { getByText } = render(
    React.createElement(RosterCard, {
      ...baseProps,
      stats: { runs: 10, completed: 8, failed: 2, approximateRuns: 5 },
    }),
  )
  assert.ok(getByText('~15'))
  cleanup()
})

test('success rate is computed only from measured completed/failed, ignoring approximateRuns entirely', () => {
  const { getByText } = render(
    React.createElement(RosterCard, {
      ...baseProps,
      stats: { runs: 10, completed: 8, failed: 2, approximateRuns: 1000 },
    }),
  )
  // 8/(8+2) = 80%, unaffected by the huge approximate bucket.
  assert.ok(getByText('80%'))
  cleanup()
})

test('a card with zero measured finishes shows the "no rate yet" dash, even with a large approximate total', () => {
  const { getByText } = render(
    React.createElement(RosterCard, {
      ...baseProps,
      stats: { runs: 0, completed: 0, failed: 0, approximateRuns: 30 },
    }),
  )
  assert.ok(getByText('—'))
  cleanup()
})
