import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Support-side pipelines: Zendesk in and out, Slack as both a source (reading
 * a customer channel) and a destination, Confluence for the written record.
 * The recurring shape is pull → classify per item with a fixed vocabulary →
 * filter deterministically → deliver, so the judgement calls are auditable.
 */

export const ZENDESK_TICKET_PULSE: FlowTemplateDef = {
  id: 'zendesk-ticket-pulse',
  name: 'Morning ticket pulse',
  description:
    'Every morning, pull the current Zendesk queue, classify each ticket with a fixed urgency vocabulary, and post the tickets that need a human first — with the reason each one made the list.',
  category: 'Support Operations',
  icon: '🎫',
  integrations: ['zendesk', 'slack'],
  tags: ['daily', 'zendesk', 'support', 'triage'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '08:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull the ticket queue',
          connectionId: '',
          toolName: 'zendesk_list_tickets',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the current queue from Zendesk. Retried twice — a triage post built on a failed read would claim the queue is empty when it is not.',
        },
      },
      {
        id: 'classify',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Classify each ticket',
          input: '{{item}}',
          instructions:
            'Classify this support ticket. Return its subject as given, an urgency of exactly one of burning, frustrated, or routine (burning means an outage or a blocked customer; frustrated means tone or repeat contact), and one sentence on why.',
          outputFields: [
            { name: 'subject', type: 'string' },
            { name: 'urgency', type: 'string' },
            { name: 'reason', type: 'string' },
          ],
          perItem: { over: '{{step.pull.output.tickets}}', itemError: 'collect', concurrency: 5 },
          retries: 1,
          note: 'One classification per ticket, five at a time, with a three-value vocabulary so the filter below can compare exactly. A malformed ticket leaves a placeholder rather than killing the morning run.',
        },
      },
      {
        id: 'hot',
        type: 'data',
        data: {
          op: 'filterArray',
          label: 'Keep the tickets that cannot wait',
          input: '{{step.classify.output}}',
          clauses: [{ left: '{{item.urgency}}', op: 'neq', right: 'routine' }],
          note: 'Deterministic cut: burning and frustrated survive, routine drops. No model call, so the bar cannot drift day to day.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the pulse post',
          input: '{{step.hot.output}}',
          instructions:
            'Write a short morning post for the support team from these classified tickets. Lead with the count that needs attention, burning ones first, each with its one-line reason. If the list is empty, say the queue looks calm. State counts exactly as given.',
          note: 'The model writes prose over the filtered list only — every subject and reason it quotes was produced upstream.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the support channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#support","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: a Slack outage should not lose the triage, which is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the hot list',
          outputs: [
            { name: 'hotTickets', value: '{{step.hot.output}}', type: 'list' },
            { name: 'post', value: '{{step.digest.output}}', type: 'text' },
          ],
          note: 'Named results, so an escalation flow can take the hot list without re-classifying anything.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'classify' },
      { id: 'e2', source: 'classify', target: 'hot' },
      { id: 'e3', source: 'hot', target: 'digest' },
      { id: 'e4', source: 'digest', target: 'post' },
      { id: 'e5', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Zendesk account to read tickets from',
      match: { provider: 'zendesk', toolName: 'zendesk_list_tickets' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the pulse to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Start every support day knowing which tickets cannot wait, without anyone reading the whole queue first. It worked if the first tickets touched each morning are the ones this post named.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Pull the ticket queue', what: 'Reads the current tickets from Zendesk.' },
      {
        nodeId: 'classify',
        title: 'Classify each ticket',
        what: 'Gives every ticket an urgency from a fixed three-value list, plus a one-line reason.',
        why: 'Per-ticket classification with a closed vocabulary, so the next step can filter by exact comparison instead of re-reading prose.',
      },
      { nodeId: 'hot', title: 'Keep the tickets that cannot wait', what: 'Drops routine tickets; burning and frustrated survive.' },
      { nodeId: 'digest', title: 'Write the pulse post', what: 'Turns the surviving tickets into a short post, burning first.' },
      { nodeId: 'post', title: 'Post to the support channel', what: 'Sends it to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the hot list', what: 'Returns the filtered tickets and the post as named results.' },
    ],
    decisionRules:
      'Burning means an outage or a blocked customer; frustrated means tone or repeat contact; everything else is routine and is filtered out. The classifier is told exactly this, so the boundary lives in one editable instruction.',
    failureHandling:
      'The queue read retries twice and fails the run rather than reporting a calm queue it never saw. Classification failures are collected per ticket instead of aborting the run. Posting continues on error, and the hot list is still returned.',
    setup: [
      { label: 'Set the channel name on the Post to the support channel step', kind: 'value', ref: 'post' },
      { label: 'Check the 08:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Tighten or widen what counts as burning by editing the classification instruction.',
      'Filter to burning only, if frustrated is producing too long a list for your queue size.',
      'Add a Zendesk update step after the post to tag the hot tickets, once you trust the classification.',
    ],
    testPlan:
      'Run it by hand against your live queue. Read the classification for five tickets you know well and check you agree with the urgency before switching the schedule on.',
  },
}

export const SUPPORT_THEME_REPORT: FlowTemplateDef = {
  id: 'support-theme-report',
  name: 'Weekly support themes to Confluence',
  description:
    'Every Monday, read the week\'s Zendesk queue, have AI name the recurring themes with counts and example tickets, and publish the report as a Confluence page the product team can cite.',
  category: 'Support Operations',
  icon: '📚',
  integrations: ['zendesk', 'confluence'],
  tags: ['weekly', 'zendesk', 'confluence', 'report'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'monday', time: '07:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull the ticket queue',
          connectionId: '',
          toolName: 'zendesk_list_tickets',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the current queue. Themes are found over the whole set at once — per-ticket summaries would lose exactly the repetition this report exists to surface.',
        },
      },
      {
        id: 'themes',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Name the recurring themes',
          input: '{{step.pull.output}}',
          instructions:
            'Group these support tickets into recurring themes. For each theme give a name, a count, and two example subjects quoted exactly. Order by count. Write the result as simple HTML using only h2, p, ul, and li tags — it becomes a Confluence page. State counts exactly; never merge unrelated tickets to make a theme look bigger.',
          note: 'One pass over the whole queue, because a theme IS the repetition across tickets. The HTML constraint is what Confluence\'s storage format accepts.',
        },
      },
      {
        id: 'publish',
        type: 'tool',
        data: {
          label: 'Publish the Confluence page',
          connectionId: '',
          toolName: 'confluence_create_page',
          args: '{"spaceKey":"","title":"Support themes — weekly report","body":"{{step.themes.output}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'A page per week builds a citable history — product can link a theme\'s page in a ticket instead of paraphrasing support anecdotes.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the report',
          outputs: [
            { name: 'report', value: '{{step.themes.output}}', type: 'text' },
            { name: 'page', value: '{{step.publish.output}}', type: 'any' },
          ],
          note: 'Named results, so a Slack flow can pick up the page link and announce it.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'themes' },
      { id: 'e2', source: 'themes', target: 'publish' },
      { id: 'e3', source: 'publish', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Zendesk account to read tickets from',
      match: { provider: 'zendesk', toolName: 'zendesk_list_tickets' },
    },
    {
      nodeId: 'publish',
      kind: 'connection',
      label: 'Pick the Confluence site to publish the report in',
      match: { provider: 'confluence', toolName: 'confluence_create_page' },
    },
  ],
  notes: {
    objective:
      'Turn a week of tickets into a named, counted list of what customers keep hitting, published where product decisions get made. It worked if a theme from this report shows up cited in a roadmap discussion.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Pull the ticket queue', what: 'Reads the current tickets from Zendesk.' },
      {
        nodeId: 'themes',
        title: 'Name the recurring themes',
        what: 'Groups the tickets into themes with counts and quoted example subjects, formatted as simple HTML.',
        why: 'Run over the whole set at once — a theme is repetition across tickets, which per-ticket summaries would destroy.',
      },
      { nodeId: 'publish', title: 'Publish the Confluence page', what: 'Creates the weekly page in the configured space.' },
      { nodeId: 'out', title: 'Return the report', what: 'Returns the report body and the created page as named results.' },
    ],
    failureHandling:
      'The queue read retries twice and fails the run rather than publishing a report over partial data. Publishing retries twice and fails loudly — a missing weekly page should be noticed, not papered over.',
    setup: [
      { label: 'Set the space key on the Publish the Confluence page step', kind: 'value', ref: 'publish' },
      { label: 'Check the Monday 07:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Add the week\'s dates to the page title so the history reads chronologically.',
      'Ask for a "new this week" section in the instruction, once a few weeks of pages exist to compare against.',
      'Add a Slack step after publishing to announce the page link.',
    ],
    testPlan:
      'Run it by hand. Check the created page renders properly in Confluence and spot-check two themes against the real tickets — the counts and example subjects must match.',
  },
}

export const CUSTOMER_CHANNEL_MONITOR: FlowTemplateDef = {
  id: 'customer-channel-monitor',
  name: 'Customer channel risk watch',
  description:
    'Every evening, read the day\'s messages in a shared customer Slack channel, extract the mood and any risk signals, and email the account lead only when something needs attention.',
  category: 'Support Operations',
  icon: '📡',
  integrations: ['slack', 'gmail'],
  tags: ['daily', 'slack', 'monitoring', 'customer-success'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '17:30', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'read',
        type: 'tool',
        data: {
          label: 'Read the customer channel',
          connectionId: '',
          toolName: 'slack_read_messages',
          args: '{"channel":"","limit":50}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the most recent messages from the shared channel. Fifty covers a day in most customer channels; raise it for busy ones.',
        },
      },
      {
        id: 'assess',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Extract mood and risk signals',
          input: '{{step.read.output}}',
          instructions:
            'Read these Slack messages from a shared customer channel. Return the overall mood as exactly one of positive, neutral, or concerning; a list of concrete risk signals (unanswered questions, frustration, mentions of alternatives, escalation language) quoting the message that shows each; and a one-paragraph summary of the day. If nothing is concerning, return an empty risk list.',
          outputFields: [
            { name: 'mood', type: 'string' },
            { name: 'risks', type: 'array' },
            { name: 'summary', type: 'string' },
          ],
          note: 'The risk list is evidence-quoted: each signal carries the message that shows it, so the email below never asks the reader to trust a vibe.',
        },
      },
      {
        id: 'worrying',
        type: 'condition',
        data: {
          label: 'Anything to flag?',
          clauses: [{ left: '{{step.assess.output.risks}}', op: 'isNotEmpty', right: '' }],
          note: 'A quiet day sends nothing. The email only exists when there is a quoted risk to act on — otherwise this flow trains the lead to ignore it.',
        },
      },
      {
        id: 'send',
        type: 'tool',
        data: {
          label: 'Email the account lead',
          connectionId: '',
          toolName: 'gmail_send_email',
          args:
            '{"to":"","subject":"Customer channel: signals worth a look today","body":"Mood: {{step.assess.output.mood}}\\n\\n{{step.assess.output.summary}}\\n\\nSignals:\\n{{step.assess.output.risks}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Sends as the connected Gmail account, so the lead can reply to the thread directly. This write goes through the approval gate the first time.',
        },
      },
      {
        id: 'quiet',
        type: 'stop',
        data: {
          label: 'Quiet day',
          reason: 'No risk signals in the channel today — no email sent.',
          note: 'Stopping early is the point: the run history still shows the check happened, without an inbox entry to prove it.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the assessment',
          outputs: [
            { name: 'mood', value: '{{step.assess.output.mood}}', type: 'text' },
            { name: 'risks', value: '{{step.assess.output.risks}}', type: 'list' },
          ],
          note: 'Named results, so a weekly roll-up can trend the mood without re-reading the channel.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'read' },
      { id: 'e1', source: 'read', target: 'assess' },
      { id: 'e2', source: 'assess', target: 'worrying' },
      { id: 'e3', source: 'worrying', target: 'send', branch: 'true' },
      { id: 'e4', source: 'worrying', target: 'quiet', branch: 'false' },
      { id: 'e5', source: 'send', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'read',
      kind: 'connection',
      label: 'Pick the Slack workspace with the shared customer channel',
      match: { provider: 'slack', toolName: 'slack_read_messages' },
    },
    {
      nodeId: 'send',
      kind: 'connection',
      label: 'Pick the Gmail account that emails the account lead',
      match: { provider: 'gmail', toolName: 'gmail_send_email' },
    },
  ],
  notes: {
    objective:
      'Catch the drift in a shared customer channel the day it starts, not at the QBR. It worked if the account lead hears about frustration from this email before the customer escalates it themselves.',
    inputs: [],
    steps: [
      { nodeId: 'read', title: 'Read the customer channel', what: 'Fetches the most recent messages from the shared channel.' },
      {
        nodeId: 'assess',
        title: 'Extract mood and risk signals',
        what: 'Returns a three-value mood, a list of risk signals each quoting its evidence, and a day summary.',
        why: 'Evidence-quoted signals, because an alert the reader cannot verify in one glance gets ignored by the third one.',
      },
      { nodeId: 'worrying', title: 'Anything to flag?', what: 'Sends the email only when the risk list is non-empty.' },
      { nodeId: 'send', title: 'Email the account lead', what: 'Sends the mood, summary, and quoted signals from the connected Gmail account.' },
      { nodeId: 'quiet', title: 'Quiet day', what: 'Ends the run without sending when there is nothing to flag.' },
      { nodeId: 'out', title: 'Return the assessment', what: 'Returns the mood and risk list as named results.' },
    ],
    decisionRules:
      'The email sends only when at least one quoted risk signal was found. Mood alone never triggers it — a neutral day with one unanswered urgent question sends; a grumpy-but-handled day does not.',
    failureHandling:
      'The channel read retries twice and fails the run rather than assessing a day it never saw. The email retries twice; as an outbound write it passes through the approval gate until you mark it trusted.',
    setup: [
      { label: 'Set the channel id on the Read the customer channel step', kind: 'value', ref: 'read' },
      { label: 'Set the recipient on the Email the account lead step', kind: 'value', ref: 'send' },
      { label: 'Check the 17:30 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Duplicate the flow per customer channel — one channel per flow keeps each email attributable.',
      'Raise the message limit on the read step for busy channels.',
      'Add Slack delivery alongside the email if your leads live in Slack, not their inbox.',
    ],
    testPlan:
      'Run it by hand on a channel with real traffic. Check each quoted signal actually appears in the channel, then post a deliberately concerning test message and confirm the email path fires.',
  },
}

export const CSAT_DETRACTOR_FOLLOWUP: FlowTemplateDef = {
  id: 'csat-detractor-followup',
  name: 'CSAT detractor follow-up',
  description:
    'When a low survey score arrives, draft a personal follow-up that addresses what the customer actually wrote, and open a Zendesk ticket carrying the draft so a human sends it within the day.',
  category: 'Support Operations',
  icon: '📉',
  integrations: ['zendesk'],
  tags: ['webhook', 'zendesk', 'csat', 'real-time'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'webhook',
            inputFields: [
              { name: 'score', type: 'number', required: true, description: 'The survey score, 0 to 10.' },
              { name: 'comment', type: 'string', required: false, description: 'What the customer wrote, if anything.' },
              { name: 'customerEmail', type: 'string', required: true, description: 'Who submitted the survey.' },
            ],
          },
        },
      },
      {
        id: 'detractor',
        type: 'condition',
        data: {
          label: 'Is it a detractor score?',
          clauses: [{ left: '{{trigger.input.score}}', op: 'lte', right: '6' }],
          note: 'Six and below, the standard NPS detractor bar. Passives and promoters end the run — this flow exists for the scores that cost renewals.',
        },
      },
      {
        id: 'draft',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Draft the follow-up',
          input: 'Score: {{trigger.input.score}}\nCustomer: {{trigger.input.customerEmail}}\nComment: {{trigger.input.comment}}',
          instructions:
            'Draft a short, personal follow-up email to this unhappy survey respondent. Address the specific thing they wrote about — quote their words once. Do not offer discounts, promise fixes, or apologise generically. If they left no comment, ask one specific question about their experience instead of guessing.',
          note: 'A draft, never sent automatically — it rides inside the ticket for a human to review, personalise, and send.',
        },
      },
      {
        id: 'ticket',
        type: 'tool',
        data: {
          label: 'Open the follow-up ticket',
          connectionId: '',
          toolName: 'zendesk_create_ticket',
          args:
            '{"subject":"Detractor follow-up: {{trigger.input.customerEmail}} scored {{trigger.input.score}}","body":"Survey comment:\\n{{trigger.input.comment}}\\n\\nSuggested reply (review before sending):\\n{{step.draft.output}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'The ticket is the handoff: it carries the score, the customer\'s words, and the draft, so the agent who picks it up starts at ninety percent done.',
        },
      },
      {
        id: 'promoter',
        type: 'stop',
        data: {
          label: 'Not a detractor',
          reason: 'Score above 6 — no follow-up ticket needed.',
          note: 'The run still appears in history, so you can verify every survey response passed through the gate.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the ticket and draft',
          outputs: [
            { name: 'ticket', value: '{{step.ticket.output}}', type: 'any' },
            { name: 'draft', value: '{{step.draft.output}}', type: 'text' },
          ],
          note: 'The survey system gets the ticket back in the webhook response, so it can link the follow-up next to the score.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'detractor' },
      { id: 'e1', source: 'detractor', target: 'draft', branch: 'true' },
      { id: 'e2', source: 'detractor', target: 'promoter', branch: 'false' },
      { id: 'e3', source: 'draft', target: 'ticket' },
      { id: 'e4', source: 'ticket', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'ticket',
      kind: 'connection',
      label: 'Pick the Zendesk account to open follow-up tickets in',
      match: { provider: 'zendesk', toolName: 'zendesk_create_ticket' },
    },
  ],
  notes: {
    objective:
      'Every detractor score becomes a human follow-up within the day, with the drafting already done. It worked if detractors get a personal reply that names their actual complaint — and passives and promoters generate no work at all.',
    inputs: [
      { name: 'score', description: 'The survey score, 0 to 10.', example: '3' },
      { name: 'comment', description: 'What the customer wrote, if anything.' },
      { name: 'customerEmail', description: 'Who submitted the survey.', example: 'ops@acme.com' },
    ],
    steps: [
      { nodeId: 'detractor', title: 'Is it a detractor score?', what: 'Continues only for scores of 6 or below.' },
      {
        nodeId: 'draft',
        title: 'Draft the follow-up',
        what: 'Writes a personal reply that quotes the customer\'s own words, or asks one specific question when there are none.',
        why: 'Drafted but never auto-sent — the cost of a wrong personal email to an already-unhappy customer is the whole relationship.',
      },
      { nodeId: 'ticket', title: 'Open the follow-up ticket', what: 'Creates a Zendesk ticket carrying the score, the comment, and the draft.' },
      { nodeId: 'promoter', title: 'Not a detractor', what: 'Ends the run for scores above 6.' },
      { nodeId: 'out', title: 'Return the ticket and draft', what: 'Returns both to the webhook caller.' },
    ],
    decisionRules:
      'Six and below opens a ticket; seven and up stops the run. Change the bar on the Is it a detractor score? step if your survey uses a different scale.',
    failureHandling:
      'Ticket creation retries twice and fails the run loudly — a detractor follow-up that silently never happened is precisely what this flow exists to prevent. The draft step retries once.',
    setup: [
      { label: 'Copy the webhook address from the trigger into your survey tool', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Change the detractor bar for a 5-point scale.',
      'Add a Slack page alongside the ticket for scores of 2 and below.',
      'Route the ticket to a specific group by adding fields to the create call, once you know your Zendesk group ids.',
    ],
    testPlan:
      'Post a score of 3 with a comment to the webhook address and check the ticket carries a draft that quotes it. Then post an 8 and confirm no ticket is created.',
  },
}
