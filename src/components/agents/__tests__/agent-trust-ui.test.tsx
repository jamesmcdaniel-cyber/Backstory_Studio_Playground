import '@/test-support/jsdom-env'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AgentScopeCard, AgentScopeSummaryLine } from '../agent-scope-card'
import { ActionLedger } from '../action-ledger'
import { mergeScopeSummaries, summarizeScope, type AgentScope } from '@/lib/agents/scope-types'
import type { AgentActionView } from '@/lib/agents/action-ledger-types'

const scope: AgentScope = {
  agentId: 'a1',
  resolvedFor: 'viewer',
  counts: { connections: 3, tools: 4, reads: 2, writes: 2, needsApproval: 1, blocked: 2 },
  connections: [
    {
      key: 'nango:nango:slack', name: 'Slack', plane: 'nango', provider: 'nango:slack', actsAs: 'user',
      tools: [
        { name: 'slack_post_message', label: 'Slack post message', access: 'write', status: 'needs_approval', approvalBy: 'agent', undo: { undoable: true, note: 'Deletes the message.' } },
        { name: 'slack_list_channels', label: 'Slack list channels', access: 'read', status: 'allowed' },
      ],
    },
    {
      key: 'mcp:acme', name: 'Acme CRM', plane: 'mcp', provider: 'acme', actsAs: 'workspace',
      tools: [
        { name: 'lookup', label: 'Lookup', access: 'read', status: 'allowed' },
        { name: 'delete_everything', label: 'Delete everything', access: 'unclassified', status: 'blocked', blockedBy: 'integration' },
        { name: 'export_all', label: 'Export all', access: 'unclassified', status: 'blocked', blockedBy: 'agent' },
      ],
    },
    { key: 'native:email', name: 'Email', plane: 'native', provider: 'email', actsAs: 'workspace', tools: [{ name: 'send_email', label: 'Send email', access: 'write', status: 'allowed', undo: { undoable: false, note: "Sent email can't be recalled." } }] },
  ],
  identity: { ownerName: 'Ana Ruiz' },
  approval: { agentRequiresApproval: true, notCoveredByAgentApproval: ['Email'] },
  data: { agentDocuments: 3, collections: [{ id: 'c1', name: 'Playbooks' }] },
  triggers: [{ kind: 'schedule', description: 'Runs every day at 09:00' }],
  notes: [],
}

test('the roster line shows counts and the trust badges', () => {
  render(<AgentScopeSummaryLine summary={summarizeScope(scope)} />)
  assert.ok(screen.getByText('4 tools'))
  assert.ok(screen.getByText(/2 write/))
  assert.ok(screen.getByText(/Asks first/))
  assert.ok(screen.getByText(/2 blocked/))
  cleanup()
})

test('a teammate line reads "up to" and asks first only when every job does', () => {
  const merged = mergeScopeSummaries([summarizeScope(scope), { ...summarizeScope(scope), agentRequiresApproval: false }])!
  render(<AgentScopeSummaryLine summary={merged} />)
  assert.ok(screen.getByText('Up to 4 tools'))
  assert.equal(screen.queryByText(/Asks first/), null)
  cleanup()
})

test('the full card says whose accounts it uses, what is held for approval and what is blocked', () => {
  render(<AgentScopeCard scope={scope} />)
  assert.ok(screen.getByText(/your own Slack; the workspace's Acme CRM, Email/))
  assert.ok(screen.getByText(/Scheduled and signal runs act as Ana Ruiz/))
  assert.ok(screen.getByText('Not held for approval: Email.'))
  assert.ok(screen.getByText(/3 documents added to this agent, and these collections: Playbooks/))
  assert.ok(screen.getByText('Runs every day at 09:00.'))
  // Writes sort first and the first connection opens on its own.
  assert.ok(screen.getByText('Asks first'))
  fireEvent.click(screen.getByRole('button', { name: /Acme CRM/ }))
  assert.ok(screen.getByText('Blocked in Integrations'))
  assert.ok(screen.getByText('Off for this agent'))
  cleanup()
})

const entry = (over: Partial<AgentActionView>): AgentActionView => ({
  id: 'e1', sourceKind: 'agent', agentTaskId: 'a1', flowId: null, runId: 'r1', actor: { id: 'u1', name: 'Ana Ruiz' }, approvedBy: null,
  provider: 'nango:slack', plane: 'nango', tool: 'slack_post_message', toolLabel: 'Slack post message', actsAs: 'user',
  argsSummary: { channel: '#revenue', text: 'Q3 is closed' }, resultRef: { channel: 'C1', ts: '1', label: '#revenue' },
  status: 'done', error: null, undoError: null, createdAt: '2026-10-22T15:00:00.000Z', undoneAt: null, undoneBy: null,
  undo: { possible: true, allowed: true, effect: 'Deletes the message.' },
  ...over,
})

test('the ledger offers Undo where it can, and says why not where it cannot', async () => {
  const original = globalThis.fetch
  const posted: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted.push(url)
      return new Response(JSON.stringify({ success: true, status: 'undone' }))
    }
    return new Response(JSON.stringify({
      success: true,
      nextCursor: null,
      items: [
        entry({}),
        entry({ id: 'e2', provider: 'nango:gmail', tool: 'gmail_send_email', toolLabel: 'Gmail send email', argsSummary: { to: 'buyer@acme.com' }, resultRef: { id: 'm1' }, undo: { possible: false, allowed: false, reason: "Sent email can't be recalled." } }),
      ],
    }))
  }) as unknown as typeof fetch
  try {
    render(<ActionLedger filter={{ agentId: 'a1' }} />)
    await waitFor(() => assert.ok(screen.getByText('Gmail send email')))
    assert.equal(screen.getAllByRole('button', { name: /^Undo$/ }).length, 1, 'only the Slack post can be undone')
    fireEvent.click(screen.getByRole('button', { name: /Gmail send email/ }))
    assert.ok(screen.getByText(/Can.t be undone: Sent email can't be recalled\./))
    fireEvent.click(screen.getByRole('button', { name: /^Undo$/ }))
    const confirm = await screen.findAllByRole('button', { name: 'Undo' })
    fireEvent.click(confirm[confirm.length - 1])
    await waitFor(() => assert.deepEqual(posted, ['/api/agent-actions/e1/undo']))
  } finally {
    globalThis.fetch = original
    cleanup()
  }
})
