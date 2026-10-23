import '@/test-support/jsdom-env'
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentScopeCard, AgentScopeSummaryLine } from '../agent-scope-card'
import { countScope, summarizeScope, type AgentScope } from '@/lib/agents/scope-types'

afterEach(() => cleanup())

const scope: AgentScope = {
  agentId: 'ext1',
  resolvedFor: 'viewer',
  counts: countScope([]),
  connections: [],
  identity: { ownerName: 'Ana Ruiz' },
  approval: { agentRequiresApproval: false, notCoveredByAgentApproval: [] },
  data: { agentDocuments: 0, collections: [] },
  triggers: [{ kind: 'slack_channel', count: 1 }],
  notes: [],
  external: {
    webhookHost: 'agent.acme.example',
    enabled: true,
    replyTimeoutMinutes: 60,
    capabilities: 'Drafts renewal briefs from what it is sent.',
    lastDelivery: { at: new Date(Date.now() - 5 * 60_000).toISOString(), status: 'delivered', error: null },
    lastReplyAt: null,
  },
}

test('the external scope card says it has no platform tools and sees only what a task sends', () => {
  render(<AgentScopeCard scope={scope} />)
  assert.ok(screen.getByText('No platform tools'))
  assert.ok(screen.getByText(/sees only what each task sends it/))
  assert.ok(screen.getByText(/explicit grant by a workspace admin/))
  assert.ok(screen.getByText('agent.acme.example'))
  assert.ok(screen.getByText(/Delivered 5 min ago/))
  assert.ok(screen.getByText(/within 60 minutes/))
  // None of the tool-plane vocabulary applies to it.
  assert.equal(screen.queryByText('Connections and tools'), null)
})

test('a failed last delivery is stated with its reason', () => {
  render(<AgentScopeCard scope={{ ...scope, external: { ...scope.external!, lastDelivery: { at: new Date().toISOString(), status: 'failed', error: 'agent.acme.example answered HTTP 503' } } }} />)
  assert.ok(screen.getByText(/Failed just now: agent.acme.example answered HTTP 503/))
})

test('the roster line for an external agent reads "No platform tools" with its host', () => {
  render(<AgentScopeSummaryLine summary={summarizeScope(scope)} />)
  assert.ok(screen.getByText('No platform tools'))
  assert.ok(screen.getByText('agent.acme.example'))
})
