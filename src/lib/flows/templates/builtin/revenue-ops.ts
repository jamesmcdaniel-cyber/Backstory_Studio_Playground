import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Revenue-side pipelines beyond the Backstory-and-Slack pair the catalogue
 * opened with: HubSpot intake, Salesforce hygiene, an inbox-triage flow that
 * delegates to the Executive Inbox agent, and a sales-to-CS handoff that
 * finishes in Gmail. Deterministic reads and writes; the judgement lives in
 * one clearly-bounded AI or agent step per flow.
 */

export const HUBSPOT_LEAD_ROUTER: FlowTemplateDef = {
  id: 'hubspot-lead-router',
  name: 'Inbound lead router',
  description:
    'When a lead arrives from your website form, score its fit, create the HubSpot contact for qualified leads and alert the sales channel — or write a polite nurture note for the rest.',
  category: 'Revenue Operations',
  icon: '🧲',
  integrations: ['hubspot', 'slack'],
  tags: ['webhook', 'hubspot', 'leads', 'real-time'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'webhook',
            inputFields: [
              { name: 'name', type: 'string', required: true, description: 'The lead\'s full name.' },
              { name: 'email', type: 'string', required: true, description: 'The lead\'s email address.' },
              { name: 'company', type: 'string', required: false, description: 'Company name, if given.' },
              { name: 'message', type: 'string', required: false, description: 'What they wrote in the form.' },
            ],
          },
        },
      },
      {
        id: 'score',
        type: 'ai',
        data: {
          aiOp: 'score',
          label: 'Score the lead',
          input: 'Name: {{trigger.input.name}}\nEmail: {{trigger.input.email}}\nCompany: {{trigger.input.company}}\nMessage: {{trigger.input.message}}',
          instructions:
            'Score this inbound lead\'s fit from 1 to 10. Weigh a business email domain, a named company, and a message describing a concrete problem as fit; weigh personal email domains and vague or promotional messages against. Score only from what is present — an empty message is unknown, not disqualifying.',
          scoreMin: 1,
          scoreMax: 10,
          retries: 1,
          note: 'The score decides routing only — nobody is rejected. Below the bar means nurture, not discard.',
        },
      },
      {
        id: 'qualified',
        type: 'condition',
        data: {
          label: 'Does it clear the bar?',
          clauses: [{ left: '{{step.score.output.score}}', op: 'gte', right: '6' }],
          note: 'Six of ten. Deterministic comparison over the score the step above produced — move the bar here, not inside the prompt.',
        },
      },
      {
        id: 'create',
        type: 'tool',
        data: {
          label: 'Create the HubSpot contact',
          connectionId: '',
          toolName: 'hubspot_create_contact',
          args:
            '{"properties":{"email":"{{trigger.input.email}}","firstname":"{{trigger.input.name}}","company":"{{trigger.input.company}}"}}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Creates the contact so the lead exists in the CRM before anyone is told about it — the alert below links to a record, not a form submission.',
        },
      },
      {
        id: 'alert',
        type: 'tool',
        data: {
          label: 'Alert the sales channel',
          connectionId: '',
          toolName: 'send_message',
          args:
            '{"channel":"#sales","text":"Qualified inbound: {{trigger.input.name}} ({{trigger.input.company}}) — {{trigger.input.message}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the contact already exists in HubSpot, so a Slack outage must not fail the intake.',
        },
      },
      {
        id: 'nurture',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Write the nurture note',
          input: 'Name: {{trigger.input.name}}\nCompany: {{trigger.input.company}}\nMessage: {{trigger.input.message}}\nScore: {{step.score.output.score}}',
          instructions:
            'Write a two-sentence internal note on this below-bar lead: what they asked for, and what would change the picture (a business domain, a concrete use case). No judgement of the person — this note is read when they come back.',
          note: 'The below-bar path still produces a record — leads that return later start from this note instead of from nothing.',
        },
      },
      {
        id: 'merge',
        type: 'join',
        data: {
          label: 'Converge the paths',
          note: 'Passthrough join: exactly one branch arrives — the alert result or the nurture note — and the output reads from named steps either way.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the routing result',
          outputs: [
            { name: 'score', value: '{{step.score.output.score}}', type: 'text' },
            { name: 'outcome', value: '{{step.merge.output}}', type: 'any' },
          ],
          note: 'The form system gets the score and outcome back in the webhook response, so it can show the lead a matching next step.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'score' },
      { id: 'e1', source: 'score', target: 'qualified' },
      { id: 'e2', source: 'qualified', target: 'create', branch: 'true' },
      { id: 'e3', source: 'qualified', target: 'nurture', branch: 'false' },
      { id: 'e4', source: 'create', target: 'alert' },
      { id: 'e5', source: 'alert', target: 'merge' },
      { id: 'e6', source: 'nurture', target: 'merge' },
      { id: 'e7', source: 'merge', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'create',
      kind: 'connection',
      label: 'Pick the HubSpot account to create contacts in',
      match: { provider: 'hubspot', toolName: 'hubspot_create_contact' },
    },
    {
      nodeId: 'alert',
      kind: 'connection',
      label: 'Pick the Slack workspace to alert on qualified leads',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Qualified inbound leads reach the CRM and the sales channel within seconds of submitting the form, and nothing below the bar is lost — it is annotated for the day it comes back. It worked if reps stop triaging form submissions by hand.',
    inputs: [
      { name: 'name', description: 'The lead\'s full name.', example: 'Dana Torres' },
      { name: 'email', description: 'The lead\'s email address.', example: 'dana@acme.com' },
      { name: 'company', description: 'Company name, if the form collects it.' },
      { name: 'message', description: 'What they wrote in the form.' },
    ],
    steps: [
      {
        nodeId: 'score',
        title: 'Score the lead',
        what: 'Rates fit 1 to 10 from the domain, company, and message.',
        why: 'Scored by stated criteria rather than routed by prose, so the bar below is one number you can tune.',
      },
      { nodeId: 'qualified', title: 'Does it clear the bar?', what: 'Routes scores of 6 and above to the CRM path, the rest to nurture.' },
      { nodeId: 'create', title: 'Create the HubSpot contact', what: 'Creates the contact with the form fields before anyone is alerted.' },
      { nodeId: 'alert', title: 'Alert the sales channel', what: 'Posts the qualified lead to Slack, and carries on if Slack is down.' },
      { nodeId: 'nurture', title: 'Write the nurture note', what: 'Records what the below-bar lead asked for and what would change the picture.' },
      { nodeId: 'merge', title: 'Converge the paths', what: 'Brings both branches back to one path for the output.' },
      { nodeId: 'out', title: 'Return the routing result', what: 'Returns the score and outcome to the webhook caller.' },
    ],
    decisionRules:
      'Six of ten clears the bar. The scorer weighs business domain, named company, and a concrete problem as fit — and is told an empty message is unknown, not disqualifying, so sparse forms under-route rather than reject.',
    failureHandling:
      'Contact creation retries twice and fails the run loudly — a qualified lead silently missing from the CRM is the worst outcome this flow can have. The Slack alert continues on error because the contact already exists.',
    setup: [
      { label: 'Set the channel name on the Alert the sales channel step', kind: 'value', ref: 'alert' },
      { label: 'Copy the webhook address from the trigger into your website form handler', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the qualification bar off 6 once you see how your real leads score.',
      'Add fields to the contact creation as your form grows — phone, role, plan interest.',
      'Route the nurture notes to a spreadsheet or list step if you want them collected, not just returned.',
    ],
    testPlan:
      'Post one strong lead (business domain, concrete problem) and one weak one to the webhook. Check the strong one lands in HubSpot and the channel, the weak one produces only a note, and both come back with scores.',
  },
}

export const SALESFORCE_HYGIENE_AUDIT: FlowTemplateDef = {
  id: 'salesforce-hygiene-audit',
  name: 'Pipeline hygiene audit',
  description:
    'Every Friday, query open Salesforce opportunities, flag the ones with past-due close dates or weeks of silence, and post a per-owner cleanup list to the revops channel.',
  category: 'Revenue Operations',
  icon: '🧹',
  integrations: ['salesforce', 'slack'],
  tags: ['weekly', 'salesforce', 'hygiene', 'pipeline'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'friday', time: '07:30', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Query open opportunities',
          connectionId: '',
          toolName: 'salesforce_query',
          args:
            '{"soql":"SELECT Id, Name, StageName, Amount, CloseDate, LastActivityDate, Owner.Name FROM Opportunity WHERE IsClosed = false ORDER BY LastActivityDate ASC NULLS FIRST LIMIT 200"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'One SOQL query, oldest activity first, nulls leading — the deals nobody has touched surface at the top of the result before any code runs.',
        },
      },
      {
        id: 'flag',
        type: 'code',
        data: {
          label: 'Flag the hygiene problems',
          language: 'javascript',
          mode: 'all',
          input: '{{step.pull.output}}',
          timeoutMs: 10000,
          code: [
            'const records = (input && input.records) || []',
            'const now = Date.now()',
            'const staleMs = 21 * 24 * 60 * 60 * 1000',
            'const flagged = []',
            'for (const opp of records) {',
            '  const problems = []',
            '  if (opp.CloseDate && new Date(opp.CloseDate).getTime() < now) problems.push("close date in the past")',
            '  if (!opp.LastActivityDate) problems.push("no activity ever logged")',
            '  else if (now - new Date(opp.LastActivityDate).getTime() > staleMs) problems.push("no activity in 21+ days")',
            '  if (problems.length) flagged.push({ name: opp.Name, stage: opp.StageName, amount: opp.Amount, owner: opp.Owner && opp.Owner.Name, problems })',
            '}',
            'return flagged',
          ].join('\n'),
          note: 'The hygiene rules are arithmetic — past-due dates and day counts — so a code step applies them identically every week. The model never decides what counts as stale.',
        },
      },
      {
        id: 'brief',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the cleanup list',
          input: '{{step.flag.output}}',
          instructions:
            'Write a Friday cleanup post from these flagged opportunities, grouped by owner. For each owner list their deals with the specific problems found. Lead with the total count and the total amount at stake. If the list is empty, say the pipeline is clean this week. State every number exactly as given.',
          note: 'Grouping and phrasing only — every deal, owner, and problem in the post was flagged by the deterministic step above.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the revops channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#revops","text":"{{step.brief.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the flagged list is still returned as a named result even when Slack is down.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the flagged deals',
          outputs: [
            { name: 'flagged', value: '{{step.flag.output}}', type: 'list' },
            { name: 'post', value: '{{step.brief.output}}', type: 'text' },
          ],
          note: 'Named results, so a follow-up flow can chase the same list on Monday and check what got fixed.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'flag' },
      { id: 'e2', source: 'flag', target: 'brief' },
      { id: 'e3', source: 'brief', target: 'post' },
      { id: 'e4', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Salesforce org to audit',
      match: { provider: 'salesforce', toolName: 'salesforce_query' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the cleanup list to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'End every week with a named, owner-grouped list of the pipeline records that are lying — past-due close dates and silent deals — so Monday\'s forecast starts from cleaner data. It worked if the flagged count shrinks week over week.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Query open opportunities', what: 'Runs one SOQL query for open opportunities, oldest activity first.' },
      {
        nodeId: 'flag',
        title: 'Flag the hygiene problems',
        what: 'Applies three fixed rules: past-due close date, no activity ever, no activity in 21 days.',
        why: 'The rules are arithmetic, so a code step applies them identically every week — the bar cannot drift with phrasing.',
      },
      { nodeId: 'brief', title: 'Write the cleanup list', what: 'Groups the flagged deals by owner into a readable Friday post.' },
      { nodeId: 'post', title: 'Post to the revops channel', what: 'Sends it to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the flagged deals', what: 'Returns the flagged list and the post as named results.' },
    ],
    decisionRules:
      'A deal is flagged if its close date is in the past, it has never had activity, or its last activity is more than 21 days old. All three thresholds live in the Flag the hygiene problems step.',
    failureHandling:
      'The query retries twice and fails the run rather than posting a "clean pipeline" it never verified. Posting continues on error, and the flagged list still comes back as a named output.',
    setup: [
      { label: 'Set the channel name on the Post to the revops channel step', kind: 'value', ref: 'post' },
      { label: 'Check the Friday 07:30 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Tune the 21-day silence bar in Flag the hygiene problems.',
      'Add rules — missing amount, stage stuck too long — as extra checks in the same code step.',
      'Narrow the SOQL to one team\'s opportunities to run this per team.',
    ],
    testPlan:
      'Run it by hand. Pick three flagged deals and verify each stated problem against the record in Salesforce before switching the schedule on.',
  },
}

export const INBOX_TRIAGE_BRIEF: FlowTemplateDef = {
  id: 'inbox-triage-brief',
  name: 'Executive inbox brief (agent-run)',
  description:
    'Every morning, your Executive Inbox agent works through the connected mailbox — what needs a reply, what can wait, what got missed — and the brief lands in Slack before the day starts.',
  category: 'Revenue Operations',
  icon: '📥',
  integrations: ['gmail', 'slack'],
  tags: ['daily', 'agents', 'gmail', 'productivity'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '07:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'triage',
        type: 'agent',
        data: {
          label: 'Triage the inbox',
          agentId: '',
          input:
            'Go through the inbox now. Return a morning brief with three sections: needs a reply today (with a one-line suggested angle each), can wait, and anything that looks dropped or overdue. Name senders and subjects exactly.',
          includeUpstreamContext: false,
          retries: 1,
          timeoutMs: 300000,
          note: 'The agent brings its own mailbox tools and judgement — the flow supplies the schedule and the delivery. Improving the agent improves this brief without touching the graph.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post the brief to Slack',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"","text":"{{step.triage.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Usually a private channel or a DM to yourself — set the channel accordingly. Continues on error so a Slack outage never loses the brief.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the brief',
          outputs: [{ name: 'brief', value: '{{step.triage.output}}', type: 'text' }],
          note: 'Named result, so the brief can also feed an email delivery or a weekly roll-up flow.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'triage' },
      { id: 'e1', source: 'triage', target: 'post' },
      { id: 'e2', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'triage',
      kind: 'agent',
      label: 'Pick the agent that triages the inbox',
      match: { agentName: 'Executive Inbox' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to deliver the brief in',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Open Slack in the morning and already know which three emails matter. It worked if the first inbox visit of the day starts from this brief instead of from scrolling.',
    inputs: [],
    steps: [
      {
        nodeId: 'triage',
        title: 'Triage the inbox',
        what: 'Runs your Executive Inbox agent, which reads the connected mailbox with its own tools and writes the three-section brief.',
        why: 'The reading happens inside the agent rather than in flow steps, so the agent\'s tools, memory, and instructions keep improving this flow from the outside.',
      },
      { nodeId: 'post', title: 'Post the brief to Slack', what: 'Delivers the brief to your chosen channel or DM, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the brief', what: 'Returns the brief as a named result.' },
    ],
    failureHandling:
      'The agent run retries once and fails the run loudly if the mailbox cannot be read — a brief that silently covers nothing would be worse than no brief. Posting continues on error, and the brief is still returned.',
    setup: [
      { label: 'Connect the Gmail account the agent will read', kind: 'integration', ref: 'gmail' },
      { label: 'Set the channel or DM on the Post the brief to Slack step', kind: 'value', ref: 'post' },
      { label: 'Check the 07:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Edit the agent itself to change how it judges urgency — the flow needs no change.',
      'Add an email delivery step after Slack if you want the brief in the inbox it describes.',
      'Move the run earlier so the brief precedes your first meeting.',
    ],
    testPlan:
      'Run it by hand and read the brief against the real inbox: every sender and subject it names must exist, and anything it calls overdue should actually be waiting on you.',
  },
}

export const ACCOUNT_HANDOFF_BRIEF: FlowTemplateDef = {
  id: 'account-handoff-brief',
  name: 'Sales-to-CS handoff brief',
  description:
    'Type an account name at close, and the flow pulls its live state from Backstory, writes the handoff brief — who matters, what was promised, where the risk is — and emails it to the incoming CSM.',
  category: 'Revenue Operations',
  icon: '🤝',
  integrations: ['backstory', 'gmail'],
  tags: ['on-demand', 'backstory', 'handoff', 'customer-success'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [
              { name: 'accountName', type: 'string', required: true, description: 'The account being handed off.' },
              { name: 'csmEmail', type: 'string', required: true, description: 'The incoming CSM\'s email address.' },
            ],
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
          note: 'Turns the typed name into the account Backstory knows. Retried twice — everything below is meaningless against the wrong account.',
        },
      },
      {
        id: 'status',
        type: 'tool',
        data: {
          label: 'Read the account status',
          connectionId: '',
          toolName: 'get_account_status',
          args: '{"peopleai_account_id":"{{step.find.output.peopleai_account_id}}"}',
          retries: 2,
          timeoutMs: 30000,
          note: 'Pulls engagement, contacts, and open work as facts from Backstory — the brief is grounded in this, not in what the model recalls about the account.',
        },
      },
      {
        id: 'brief',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the handoff brief',
          input: '{{step.status.output}}',
          instructions:
            'Write a sales-to-CS handoff brief from this account data. Sections: the relationship (who is engaged, who has gone quiet), commitments and expectations visible in the record, current usage or deployment state, and the two biggest risks for the first ninety days. Only state what the data shows; where it is silent, say so — a wrong "fact" in a handoff outlives the handoff.',
          note: 'The instruction forbids filling gaps: a handoff brief is trusted verbatim by someone with no history on the account, so silence must be labelled silence.',
        },
      },
      {
        id: 'send',
        type: 'tool',
        data: {
          label: 'Email the incoming CSM',
          connectionId: '',
          toolName: 'gmail_send_email',
          args:
            '{"to":"{{trigger.input.csmEmail}}","subject":"Handoff brief: {{trigger.input.accountName}}","body":"{{step.brief.output}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Sends from the connected Gmail account so the CSM can reply with questions onto a real thread. Goes through the approval gate until trusted.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the brief',
          outputs: [{ name: 'brief', value: '{{step.brief.output}}', type: 'text' }],
          note: 'Named result, so the brief can also be filed to a wiki or attached to the account record by another flow.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'find' },
      { id: 'e1', source: 'find', target: 'status' },
      { id: 'e2', source: 'status', target: 'brief' },
      { id: 'e3', source: 'brief', target: 'send' },
      { id: 'e4', source: 'send', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'find',
      kind: 'connection',
      label: 'Pick the Backstory connection to look the account up in',
      match: { provider: 'backstory', toolName: 'find_account' },
    },
    {
      nodeId: 'status',
      kind: 'connection',
      label: 'Pick the Backstory connection to read the account status from',
      match: { provider: 'backstory', toolName: 'get_account_status' },
    },
    {
      nodeId: 'send',
      kind: 'connection',
      label: 'Pick the Gmail account that sends the handoff brief',
      match: { provider: 'gmail', toolName: 'gmail_send_email' },
    },
  ],
  notes: {
    objective:
      'Every closed deal hands the CS team a grounded brief the same day, written from the account\'s live record rather than the rep\'s memory. It worked if the CSM\'s first customer call needs no "so, catch me up" internal meeting before it.',
    inputs: [
      { name: 'accountName', description: 'The account being handed off.', example: 'Acme Industries' },
      { name: 'csmEmail', description: 'The incoming CSM\'s email address.', example: 'csm@yourco.com' },
    ],
    steps: [
      { nodeId: 'find', title: 'Find the account in Backstory', what: 'Resolves the typed name to the account Backstory knows.' },
      { nodeId: 'status', title: 'Read the account status', what: 'Pulls engagement, contacts, and open work as facts.' },
      {
        nodeId: 'brief',
        title: 'Write the handoff brief',
        what: 'Writes the relationship, commitments, deployment state, and first-ninety-days risks — and labels every gap as a gap.',
        why: 'The reader has no history on the account and will trust the brief verbatim, so the instruction forbids filling silence with plausible guesses.',
      },
      { nodeId: 'send', title: 'Email the incoming CSM', what: 'Sends the brief from the connected Gmail account.' },
      { nodeId: 'out', title: 'Return the brief', what: 'Returns the brief as a named result.' },
    ],
    failureHandling:
      'Both Backstory reads retry twice and fail the run if they cannot succeed — a handoff brief over a half-loaded account is worse than none. The email retries twice and passes through the approval gate until you mark it trusted.',
    setup: [],
    customize: [
      'Add a Slack step to announce the handoff in the CS channel alongside the email.',
      'Add the Ask SalesAI step from the Account plan template before the brief for a richer risk section.',
      'Change the brief\'s sections in the instruction to match your CS team\'s handoff checklist.',
    ],
    testPlan:
      'Run it with an account you know well and read the brief critically: every claim should trace to the status data, and every gap you know about should be named as a gap, not papered over.',
  },
}
