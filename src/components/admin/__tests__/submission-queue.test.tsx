import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen } from '@testing-library/react'
import { SubmissionQueue } from '../submission-queue'

const submissions = [
  {
    id: 's1',
    kind: 'flow_template',
    title: 'Weekly pipeline digest',
    summary: 'Summarises pipeline movement every Monday.',
    status: 'pending',
    organizationId: 'org-1',
    createdAt: new Date('2026-07-20T10:00:00Z').toISOString(),
  },
]

test('the queue lists a pending submission with a plain-English kind', () => {
  render(<SubmissionQueue submissions={submissions} selectedId={null} onSelect={() => {}} />)
  assert.ok(screen.getByText('Weekly pipeline digest'))
  // Plain English, never the raw enum and never token syntax.
  assert.ok(screen.getByText('Flow template'))
  assert.equal(screen.queryByText(/flow_template/), null)
})

test('an empty queue says so rather than rendering a bare list', () => {
  render(<SubmissionQueue submissions={[]} selectedId={null} onSelect={() => {}} />)
  assert.ok(screen.getByText(/nothing waiting for review/i))
})
