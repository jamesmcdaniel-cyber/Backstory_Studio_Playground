import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Showcases event-driven entry plus true fan-out: an escalation runs the
 * notification and the draft reply concurrently (two edges out of one branch,
 * which the DAG scheduler runs at the same time), and everything converges on a
 * join that appends both results.
 */
export const WEBHOOK_TRIAGE: FlowTemplateDef = {
  id: 'webhook-triage',
  name: 'Inbound message triage',
  description:
    'Start from an inbound webhook, classify what arrived, and route it — escalations notify on-call and draft a reply at the same time, renewals get a note, everything else stops early.',
  category: 'Account Monitoring',
  icon: '📨',
  integrations: ['slack'],
  tags: ['webhook', 'routing', 'real-time'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'webhook',
            inputFields: [
              { name: 'subject', type: 'string', required: true, description: 'Subject line or title of the inbound message.' },
              { name: 'body', type: 'string', required: true, description: 'The message text.' },
              { name: 'from', type: 'string', required: false, description: 'Who sent it.' },
            ],
          },
        },
      },
      {
        id: 'classify',
        type: 'ai',
        data: {
          aiOp: 'categorize',
          label: 'What kind of message is this?',
          input: 'Subject: {{trigger.input.subject}}\n\n{{trigger.input.body}}',
          categories: ['support escalation', 'renewal risk', 'deal progression', 'not customer-relevant'],
          instructions: 'Pick the single best fit. When it is genuinely ambiguous, prefer the lower-urgency category.',
          note: 'A fixed category list means the routing below can be exact — the model picks one of four, it does not invent a fifth.',
        },
      },
      {
        id: 'route',
        type: 'switch',
        data: {
          label: 'Route on the category',
          cases: [
            { id: 'escalation', label: 'Support escalation', left: '{{step.classify.output.category}}', op: 'eq', right: 'support escalation' },
            { id: 'renewal', label: 'Renewal risk', left: '{{step.classify.output.category}}', op: 'eq', right: 'renewal risk' },
          ],
          note: 'Two urgent categories get their own paths; deal progression and anything not customer-relevant fall through to the default.',
        },
      },
      {
        id: 'notify-oncall',
        type: 'tool',
        data: {
          label: 'Page on-call',
          connectionId: '',
          toolName: 'send_message',
          args:
            '{"channel":"#support-escalations","text":"Escalation from {{trigger.input.from}} — {{trigger.input.subject}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Runs at the same time as the draft reply below — neither waits for the other, so the page goes out immediately.',
        },
      },
      {
        id: 'draft-reply',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Draft a holding reply',
          input: 'Subject: {{trigger.input.subject}}\n\n{{trigger.input.body}}',
          instructions:
            'Write a short holding reply that acknowledges the specific problem raised and says someone is picking it up. Do not promise a fix, a cause, or a timeline.',
          note: 'A draft, never sent automatically — it comes back in the results for a human to send.',
        },
      },
      {
        id: 'renewal-note',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Summarize the renewal signal',
          input: 'Subject: {{trigger.input.subject}}\n\n{{trigger.input.body}}',
          instructions: 'Two sentences: what the customer signalled, and what it implies for the renewal.',
          note: 'Renewal risk is worth recording but not worth paging anyone at 2am.',
        },
      },
      {
        id: 'ignore',
        type: 'stop',
        data: {
          label: 'Nothing to do',
          reason: 'Not customer-relevant — no action taken.',
          note: 'Stopping early is deliberate: a run that ends here still shows up in the history, so you can check what is being filtered out.',
        },
      },
      {
        id: 'merge',
        type: 'join',
        data: {
          label: 'Collect what the branch produced',
          mode: 'append',
          note: 'Append mode, because the escalation path arrives with two results. Passthrough would keep only one of them.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the triage result',
          outputs: [
            { name: 'category', value: '{{step.classify.output.category}}', type: 'text' },
            { name: 'actions', value: '{{step.merge.output}}', type: 'list' },
          ],
          note: 'A webhook caller gets these back in the response, so the sending system learns how its message was classified.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'classify' },
      { id: 'e1', source: 'classify', target: 'route' },
      { id: 'e2', source: 'route', target: 'notify-oncall', branch: 'escalation' },
      { id: 'e3', source: 'route', target: 'draft-reply', branch: 'escalation' },
      { id: 'e4', source: 'route', target: 'renewal-note', branch: 'renewal' },
      { id: 'e5', source: 'route', target: 'ignore', branch: 'default' },
      { id: 'e6', source: 'notify-oncall', target: 'merge' },
      { id: 'e7', source: 'draft-reply', target: 'merge' },
      { id: 'e8', source: 'renewal-note', target: 'merge' },
      { id: 'e9', source: 'merge', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'notify-oncall',
      kind: 'connection',
      label: 'Pick the Slack workspace to page on-call in',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Classify every inbound customer message the moment it arrives and take the right action for its kind, without a person reading it first. It worked if escalations are paged within seconds and nothing customer-relevant reaches the stop path.',
    inputs: [
      { name: 'subject', description: 'Subject line or title of the inbound message.', example: 'Re: production outage since 09:00' },
      { name: 'body', description: 'The message text.' },
      { name: 'from', description: 'Who sent it — used in the escalation page.', example: 'ops@acme.com' },
    ],
    steps: [
      {
        nodeId: 'classify',
        title: 'What kind of message is this?',
        what: 'Sorts the message into one of four fixed categories.',
        why: 'A closed list means the routing can compare exactly, rather than pattern-matching free text.',
      },
      { nodeId: 'route', title: 'Route on the category', what: 'Sends escalations and renewal risks down their own paths; everything else takes the default.' },
      {
        nodeId: 'notify-oncall',
        title: 'Page on-call',
        what: 'Posts the escalation to Slack straight away.',
        why: 'It runs alongside the draft reply rather than before it, so the page is not held up by writing prose.',
      },
      { nodeId: 'draft-reply', title: 'Draft a holding reply', what: 'Writes an acknowledgement for a human to send. Never sends it.' },
      { nodeId: 'renewal-note', title: 'Summarize the renewal signal', what: 'Records what the customer signalled and what it means for the renewal.' },
      { nodeId: 'ignore', title: 'Nothing to do', what: 'Ends the run early for anything not customer-relevant.' },
      {
        nodeId: 'merge',
        title: 'Collect what the branch produced',
        what: 'Combines the results of whichever steps ran into one list.',
        why: 'Append rather than passthrough, because the escalation path produces two results and passthrough would drop one.',
      },
      { nodeId: 'out', title: 'Return the triage result', what: 'Returns the category and the actions taken to the caller.' },
    ],
    decisionRules:
      'Support escalation pages on-call and drafts a reply. Renewal risk gets a written note. Deal progression and anything not customer-relevant stop the run. On a genuinely ambiguous message the classifier is told to pick the lower-urgency category, so borderline cases under-page rather than over-page.',
    failureHandling:
      'The Slack page retries twice and then continues, so a messaging outage still leaves the draft reply and the classification in the results. There is no dead-letter path — check the runs list for failures.',
    setup: [
      { label: 'Connect Slack and pick the escalation channel', kind: 'integration', ref: 'slack' },
      { label: 'Copy the webhook address from the trigger into the system that will post to it', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Add or rename categories on What kind of message is this? — then add a matching case to the routing.',
      'Point the escalation path at an agent instead, if you want the reply drafted with account history.',
      'Add a step after the draft reply that actually sends it, once you trust the drafts.',
    ],
    testPlan:
      'Post one message of each kind to the webhook address and check each takes the path you expect. Confirm an escalation returns two entries in actions and that a not-customer-relevant message ends at the stop step.',
  },
}
