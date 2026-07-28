import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * The enrichment-chain shape: three real Backstory MCP tools called in sequence
 * — resolve the account by name, read its status, then ask SalesAI a pointed
 * question — before any model writes a word. The account planning agent then
 * gets facts rather than a name, and a human approves before the plan is
 * returned.
 *
 * Deliberately not a fan-out: it answers "brief me on THIS account, now", which
 * is the request a rep actually makes before a call.
 */
export const ACCOUNT_PLAN: FlowTemplateDef = {
  id: 'account-plan',
  name: 'Account plan on demand',
  description:
    'Name an account and get a plan: Backstory resolves it, reads its current status, and asks SalesAI where the relationship stands, then your account-planning agent turns that into a strategy a human approves before it goes out.',
  category: 'Strategic Intelligence',
  icon: '📇',
  integrations: ['backstory'],
  tags: ['on-demand', 'account', 'approval'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [{ name: 'accountName', type: 'string', required: true, description: 'The account to plan for.' }],
          },
        },
      },
      {
        id: 'find',
        type: 'tool',
        data: {
          label: 'Find the account in Backstory',
          connectionId: '',
          toolName: 'find_account',
          args: '{"account_name":"{{trigger.input.accountName}}"}',
          retries: 2,
          timeoutMs: 30000,
          note: 'Turns the name a rep typed into the account Backstory knows about. Retried twice, because a name that fails to resolve makes every step below meaningless.',
        },
      },
      {
        id: 'status',
        type: 'tool',
        data: {
          label: 'Read the account status',
          connectionId: '',
          toolName: 'get_account_status',
          args: '{"peopleai_account_id":"{{step.find.output}}"}',
          retries: 2,
          timeoutMs: 30000,
          note: 'Pulls the current state — engagement, open opportunities, recent movement — as facts, not as something the model recalls. Takes the id straight from the lookup above; if your Backstory returns the id nested inside a record, point this at that field instead.',
        },
      },
      {
        id: 'ask',
        type: 'tool',
        data: {
          label: 'Ask SalesAI where it stands',
          connectionId: '',
          toolName: 'ask_sales_ai_about_account',
          args:
            '{"peopleai_account_id":"{{step.find.output}}","question":"What has changed on this account in the last 90 days, who is engaged, and what is the biggest risk to the relationship?"}',
          retries: 1,
          onError: 'continue',
          timeoutMs: 45000,
          note: 'One pointed question rather than a broad dump. Set to continue on error: the plan is still worth writing from the status alone if this call fails.',
        },
      },
      {
        id: 'plan',
        type: 'agent',
        data: {
          label: 'Write the account plan',
          agentId: '',
          input:
            'Write an account plan for {{trigger.input.accountName}}.\n\nCurrent status:\n{{step.status.output}}\n\nWhat SalesAI says:\n{{step.ask.output}}',
          includeUpstreamContext: true,
          retries: 1,
          timeoutMs: 300000,
          note: 'The agent brings the planning judgement and its own tools; this flow brings it verified facts, so the plan is grounded in what Backstory actually returned rather than in what the model remembers.',
        },
      },
      {
        id: 'approve',
        type: 'humanReview',
        data: {
          label: 'Approve before it goes out',
          message:
            'Account plan for {{trigger.input.accountName}}. Reply with any edits, or approve as-is.',
          note: 'An account plan carries a point of view about a customer, so a person signs it off before anyone acts on it. The run pauses here until someone replies, and their reply becomes this step\'s result.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the plan',
          outputs: [
            { name: 'account', value: '{{trigger.input.accountName}}', type: 'text' },
            { name: 'plan', value: '{{step.plan.output}}', type: 'text' },
            { name: 'review', value: '{{step.approve.output}}', type: 'text' },
          ],
          note: 'Returns the plan alongside the reviewer\'s reply, so the approval is part of the record rather than lost in a runs list.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'find' },
      { id: 'e1', source: 'find', target: 'status' },
      { id: 'e2', source: 'status', target: 'ask' },
      { id: 'e3', source: 'ask', target: 'plan' },
      { id: 'e4', source: 'plan', target: 'approve' },
      { id: 'e5', source: 'approve', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'find',
      kind: 'connection',
      label: 'Pick the Backstory connection to look accounts up in',
      match: { provider: 'backstory', toolName: 'find_account' },
    },
    {
      nodeId: 'status',
      kind: 'connection',
      label: 'Pick the Backstory connection to read account status from',
      match: { provider: 'backstory', toolName: 'get_account_status' },
    },
    {
      nodeId: 'ask',
      kind: 'connection',
      label: 'Pick the Backstory connection to ask SalesAI through',
      match: { provider: 'backstory', toolName: 'ask_sales_ai_about_account' },
    },
    {
      nodeId: 'plan',
      kind: 'agent',
      label: 'Pick the agent that writes account plans',
      // Matches the "Account Planning & Strategy" agent template.
      match: { agentName: 'Account Planning & Strategy' },
    },
  ],
  notes: {
    objective:
      'Turn an account name into a plan grounded in what Backstory actually knows about that account, reviewed by a human before it is used. It worked if the reviewer approves most plans unedited and every claim in one can be traced to the status or the SalesAI answer above it.',
    inputs: [
      { name: 'accountName', description: 'The account to plan for, as a rep would type it.', example: 'Acme Corporation' },
    ],
    steps: [
      {
        nodeId: 'find',
        title: 'Find the account in Backstory',
        what: 'Resolves the typed name to the account Backstory holds.',
        why: 'Every step below is keyed to the resolved account, so this is the one step worth retrying hard.',
      },
      { nodeId: 'status', title: 'Read the account status', what: 'Pulls engagement, open opportunities, and recent movement as facts.' },
      {
        nodeId: 'ask',
        title: 'Ask SalesAI where it stands',
        what: 'Asks one pointed question about the last 90 days, who is engaged, and the biggest risk.',
        why: 'It continues on error, so a failure here costs the plan some colour rather than the whole run.',
      },
      {
        nodeId: 'plan',
        title: 'Write the account plan',
        what: 'Hands the verified facts to your account-planning agent.',
        why: 'The judgement lives in the agent, so improving the agent improves every plan without editing this flow.',
      },
      { nodeId: 'approve', title: 'Approve before it goes out', what: 'Pauses until a person approves the plan or says what to change.' },
      { nodeId: 'out', title: 'Return the plan', what: 'Returns the account, the plan, and the reviewer\'s reply.' },
    ],
    decisionRules:
      'There is no branching here on purpose — every account gets the same three lookups and the same agent. What varies is the input, and what the account status and SalesAI answer come back with.',
    failureHandling:
      'The account lookup and the status read each retry twice and fail the run if they cannot succeed, because a plan built without them would be guesswork. The SalesAI question continues on error. The agent retries once. The approval step has no timer, so a plan nobody reviews stays waiting rather than going out unread.',
    setup: [
      { label: 'Run it once and confirm the account id from the lookup is what the status and SalesAI steps expect', kind: 'value', ref: 'status' },
      { label: 'Check the SalesAI question on the Ask SalesAI where it stands step says what you want to know', kind: 'value', ref: 'ask' },
    ],
    customize: [
      'Change the SalesAI question — it is the one knob that most changes what the plan talks about.',
      'Swap the planning agent for one of your own; the flow only needs it to accept facts and return prose.',
      'Add a delivery step after the approval to send the plan to the account team.',
      'Turn the manual trigger into a schedule over a list of accounts if you want plans refreshed rather than requested.',
    ],
    testPlan:
      'Run it by hand with an account you know well. Check that the account resolves, that the status step returns real detail, and that nothing in the plan contradicts what those two steps returned before you rely on it.',
  },
}
