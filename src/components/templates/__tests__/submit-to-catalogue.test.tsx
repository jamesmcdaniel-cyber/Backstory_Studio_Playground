import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, cleanup, screen } from '@testing-library/react'
import { SubmitToCatalogue } from '../submit-to-catalogue'

const item = { id: 't1', kind: 'agent_template' as const, name: 'Weekly digest' }

test('a workspace without submit rights sees no catalogue affordance', () => {
  try {
    render(<SubmitToCatalogue item={item} canSubmit={false} submission={null} />)
    assert.equal(screen.queryByRole('button', { name: /submit to catalogue/i }), null)
  } finally { cleanup() }
})

test('a workspace with submit rights can open the submit form', () => {
  try {
    render(<SubmitToCatalogue item={item} canSubmit submission={null} />)
    assert.ok(screen.getByRole('button', { name: /submit to catalogue/i }))
  } finally { cleanup() }
})

test('a pending submission shows its status instead of the submit button', () => {
  try {
    render(<SubmitToCatalogue item={item} canSubmit submission={{ id: 's1', status: 'pending', reviewNote: null }} />)
    assert.ok(screen.getByText(/waiting for review/i))
    assert.equal(screen.queryByRole('button', { name: /submit to catalogue/i }), null)
  } finally { cleanup() }
})

test('a changes-requested submission shows the reviewer note and lets the author resubmit', () => {
  try {
    render(
      <SubmitToCatalogue
        item={item}
        canSubmit
        submission={{ id: 's1', status: 'changes_requested', reviewNote: 'Add a setup step.' }}
      />,
    )
    assert.ok(screen.getByText('Add a setup step.'))
    assert.ok(screen.getByRole('button', { name: /submit to catalogue/i }))
  } finally { cleanup() }
})
