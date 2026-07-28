import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Showcases the branch-and-merge shape: a switch that picks a depth of work
 * based on how close the renewal is, three different paths, a join that brings
 * them back to one, and a human approval gate before anything is returned.
 */
export const RENEWAL_BRIEF: FlowTemplateDef = {
  id: 'renewal-brief',
  name: 'Renewal brief (60 / 30 / 15 day)',
  description:
    'Each morning, find the nearest upcoming renewal and write a brief whose depth matches how close it is — a full agent workup inside 15 days, a lighter note further out — then hold it for a human to approve.',
  category: 'Customer Success',
  icon: '🔁',
  integrations: [],
  tags: ['daily', 'branching', 'approval'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '06:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'fetch',
        type: 'tool',
        data: {
          label: 'Find upcoming renewals',
          connectionId: '',
          toolName: 'list_renewals',
          args: '{"withinDays":60}',
          retries: 2,
          timeoutMs: 30000,
          note: 'Reads renewals due in the next 60 days from your CRM. Retried twice — a transient CRM blip should not skip a day.',
        },
      },
      {
        id: 'next-up',
        type: 'data',
        data: {
          op: 'getItem',
          label: 'Take the nearest one',
          input: '{{step.fetch.output}}',
          index: '0',
          note: 'One brief a day, for whichever renewal is closest. Turn this into a per-item step if you would rather brief all of them at once.',
        },
      },
      {
        id: 'facts',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Read off the key facts',
          input: '{{step.next-up.output}}',
          outputFields: [
            { name: 'accountName', type: 'string' },
            { name: 'daysToRenewal', type: 'number' },
            { name: 'annualValue', type: 'number' },
          ],
          note: 'Pulls three typed fields out of the record so the branch below can compare a real number rather than guess from prose.',
        },
      },
      {
        id: 'urgency',
        type: 'switch',
        data: {
          label: 'How close is it?',
          cases: [
            { id: 'critical', label: 'Inside 15 days', left: '{{step.facts.output.daysToRenewal}}', op: 'lte', right: '15' },
            { id: 'soon', label: 'Inside 30 days', left: '{{step.facts.output.daysToRenewal}}', op: 'lte', right: '30' },
          ],
          note: 'First match wins, so the 15-day case is listed before the 30-day one. Anything further out takes the default path.',
        },
      },
      {
        id: 'brief-critical',
        type: 'agent',
        data: {
          label: 'Full workup (inside 15 days)',
          agentId: '',
          input:
            'Write a full renewal brief for {{step.facts.output.accountName}}, which renews in {{step.facts.output.daysToRenewal}} days. Cover account health, the risks you can evidence, expansion openings, and a recommended strategy for the call.',
          includeUpstreamContext: true,
          retries: 1,
          note: 'Only the closest renewals get an agent with tools and memory — that is the expensive path, reserved for where it pays.',
        },
      },
      {
        id: 'brief-soon',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Short brief (inside 30 days)',
          input: '{{step.next-up.output}}',
          instructions:
            'Write a half-page renewal brief: current health, the one risk worth naming, and the next action. Do not speculate beyond the record.',
          note: 'A single prompt rather than an agent — enough for a renewal still a few weeks out.',
        },
      },
      {
        id: 'brief-standard',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Heads-up note (further out)',
          input: '{{step.next-up.output}}',
          instructions: 'Two or three sentences: which account, when it renews, and anything already worth watching.',
          note: 'The cheapest path. A renewal 45 days out needs awareness, not a workup.',
        },
      },
      {
        id: 'merge',
        type: 'join',
        data: {
          label: 'Whichever brief was written',
          mode: 'passthrough',
          note: 'Exactly one branch runs, so this forwards its result. Without a join, every step after the switch would need duplicating three times.',
        },
      },
      {
        id: 'approve',
        type: 'humanReview',
        data: {
          label: 'Approve before it goes out',
          message:
            'Renewal brief for {{step.facts.output.accountName}} — renews in {{step.facts.output.daysToRenewal}} days. Reply with any edits, or approve as-is.',
          note: 'The run pauses here until someone replies. Their reply becomes this step\'s result and is returned alongside the brief.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the brief',
          outputs: [
            { name: 'account', value: '{{step.facts.output.accountName}}', type: 'text' },
            { name: 'brief', value: '{{step.merge.output}}', type: 'text' },
            { name: 'reviewerNotes', value: '{{step.approve.output}}', type: 'text' },
          ],
          note: 'The brief plus whatever the reviewer said, so the approval is part of the record.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'fetch' },
      { id: 'e1', source: 'fetch', target: 'next-up' },
      { id: 'e2', source: 'next-up', target: 'facts' },
      { id: 'e3', source: 'facts', target: 'urgency' },
      { id: 'e4', source: 'urgency', target: 'brief-critical', branch: 'critical' },
      { id: 'e5', source: 'urgency', target: 'brief-soon', branch: 'soon' },
      { id: 'e6', source: 'urgency', target: 'brief-standard', branch: 'default' },
      { id: 'e7', source: 'brief-critical', target: 'merge' },
      { id: 'e8', source: 'brief-soon', target: 'merge' },
      { id: 'e9', source: 'brief-standard', target: 'merge' },
      { id: 'e10', source: 'merge', target: 'approve' },
      { id: 'e11', source: 'approve', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'fetch',
      kind: 'connection',
      label: 'Pick the CRM to read renewals from',
      match: { provider: 'salesforce', toolName: 'list_renewals' },
    },
    {
      nodeId: 'brief-critical',
      kind: 'agent',
      label: 'Pick the agent that writes full renewal briefs',
      match: { agentName: 'Renewal Brief' },
    },
  ],
  notes: {
    objective:
      'Put a renewal brief in a human\'s hands every morning, with the depth of the brief matched to how close the renewal is. It worked if the reviewer approves most briefs unedited and the 15-day ones are visibly more thorough.',
    inputs: [],
    steps: [
      { nodeId: 'fetch', title: 'Find upcoming renewals', what: 'Reads renewals due in the next 60 days from your CRM.' },
      { nodeId: 'next-up', title: 'Take the nearest one', what: 'Picks the first renewal in the list — one brief per day.' },
      {
        nodeId: 'facts',
        title: 'Read off the key facts',
        what: 'Extracts account name, days to renewal, and annual value as typed fields.',
        why: 'The branch below compares a real number; extracting it first means the routing never depends on the model reading prose correctly.',
      },
      { nodeId: 'urgency', title: 'How close is it?', what: 'Routes to one of three paths on days-to-renewal.' },
      { nodeId: 'brief-critical', title: 'Full workup (inside 15 days)', what: 'Hands the account to an agent for a complete brief.' },
      { nodeId: 'brief-soon', title: 'Short brief (inside 30 days)', what: 'Writes a half-page brief with one prompt.' },
      { nodeId: 'brief-standard', title: 'Heads-up note (further out)', what: 'Writes two or three sentences of awareness.' },
      {
        nodeId: 'merge',
        title: 'Whichever brief was written',
        what: 'Brings the three paths back to one.',
        why: 'Without it, approval and output would each need duplicating on all three branches.',
      },
      { nodeId: 'approve', title: 'Approve before it goes out', what: 'Pauses until a person replies with edits or an approval.' },
      { nodeId: 'out', title: 'Return the brief', what: 'Returns the account, the brief, and the reviewer\'s reply.' },
    ],
    decisionRules:
      'Inside 15 days takes the full agent workup. Inside 30 days takes the short brief. Anything further out takes the heads-up note. Cases are evaluated top-down, so the tightest window is listed first.',
    failureHandling:
      'The CRM read retries twice before failing the run. The agent path retries once. The approval step has no timer — the run stays waiting until someone answers, so use the runs list to spot briefs nobody picked up.',
    setup: [
      { label: 'Connect the CRM you track renewals in', kind: 'integration', ref: 'salesforce' },
      { label: 'Create or pick an agent to write the full 15-day briefs', kind: 'agent', ref: 'brief-critical' },
      { label: 'Confirm the read action name matches your CRM', kind: 'value', ref: 'fetch' },
    ],
    customize: [
      'Move the 15 and 30 day thresholds to match your renewal motion.',
      'Turn Take the nearest one into a per-item step to brief every upcoming renewal instead of just the closest.',
      'Assign the approval to a specific person rather than the flow owner.',
      'Add a delivery step after approval to send the brief on to the account team.',
    ],
    testPlan:
      'Run it by hand and check the switch picks the path you expect for the returned days-to-renewal. Then answer the approval prompt and confirm your reply comes back in the results.',
  },
}
