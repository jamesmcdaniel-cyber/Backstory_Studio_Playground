import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Ritual-replacement pipelines: the recurring meetings and status emails a
 * team runs on muscle memory, rebuilt as flows — sprint health to Confluence,
 * a Monday.com snapshot by email, a customer kickoff that files the task and
 * announces itself, and a Friday exec brief that delivers to two channels.
 */

export const JIRA_SPRINT_HEALTH: FlowTemplateDef = {
  id: 'jira-sprint-health',
  name: 'Sprint health report',
  description:
    'Mid-sprint, query the open sprint\'s Jira issues, tally the real numbers by status and assignee, and publish a health report to Confluence that names what is blocked and who is overloaded.',
  category: 'Team Cadence',
  icon: '🏃',
  integrations: ['jira', 'confluence'],
  tags: ['weekly', 'jira', 'confluence', 'sprint'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'wednesday', time: '09:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Query the open sprint',
          connectionId: '',
          toolName: 'jira_list_issues',
          args: '{"jql":"sprint in openSprints() ORDER BY updated DESC","maxResults":100}',
          retries: 2,
          timeoutMs: 60000,
          note: 'One JQL query for everything in the currently open sprint. Narrow it with a project clause if several teams share the site.',
        },
      },
      {
        id: 'tally',
        type: 'code',
        data: {
          label: 'Tally the sprint numbers',
          language: 'javascript',
          mode: 'all',
          input: '{{step.pull.output}}',
          timeoutMs: 10000,
          code: [
            'const issues = (input && input.issues) || []',
            'const byStatus = {}',
            'const byAssignee = {}',
            'for (const issue of issues) {',
            '  const f = issue.fields || {}',
            '  const status = (f.status && f.status.name) || "unknown"',
            '  const who = (f.assignee && f.assignee.displayName) || "unassigned"',
            '  byStatus[status] = (byStatus[status] || 0) + 1',
            '  if (status.toLowerCase() !== "done") byAssignee[who] = (byAssignee[who] || 0) + 1',
            '}',
            'return { total: issues.length, byStatus, openByAssignee: byAssignee }',
          ].join('\n'),
          note: 'The counts are computed, not estimated — the report below may only phrase numbers this step produced.',
        },
      },
      {
        id: 'report',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the health report',
          input: 'Tallies: {{step.tally.output}}\n\nIssues: {{step.pull.output}}',
          instructions:
            'Write a mid-sprint health report as simple HTML using only h2, p, ul, and li tags. Sections: the numbers (from the tallies, stated exactly), what looks blocked or stalled (issues not updated recently or sitting in review), and load (anyone carrying a clearly larger share of open issues). Name issues by key and title exactly as given. No advice section — the report states, the team decides.',
          note: 'The tallies anchor the numbers; the issue list gives the model titles and keys to cite. It phrases and flags — it never counts.',
        },
      },
      {
        id: 'publish',
        type: 'tool',
        data: {
          label: 'Publish to Confluence',
          connectionId: '',
          toolName: 'confluence_create_page',
          args: '{"spaceKey":"","title":"Sprint health — mid-sprint report","body":"{{step.report.output}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'A page per sprint builds the retro record — by retro day, the mid-sprint state is already written down instead of remembered.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the report',
          outputs: [
            { name: 'tallies', value: '{{step.tally.output}}', type: 'any' },
            { name: 'page', value: '{{step.publish.output}}', type: 'any' },
          ],
          note: 'Named results, so a Slack flow can announce the page and a dashboard can trend the tallies.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'tally' },
      { id: 'e2', source: 'tally', target: 'report' },
      { id: 'e3', source: 'report', target: 'publish' },
      { id: 'e4', source: 'publish', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Jira site to read the sprint from',
      match: { provider: 'jira', toolName: 'jira_list_issues' },
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
      'The mid-sprint check-in writes itself: real counts, named blockers, and visible load, filed where the retro will look for it. It worked if the retro opens with this page instead of with recollections.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Query the open sprint', what: 'Reads every issue in the currently open sprint via one JQL query.' },
      {
        nodeId: 'tally',
        title: 'Tally the sprint numbers',
        what: 'Counts issues by status and open issues by assignee.',
        why: 'Counting is arithmetic — the report can only phrase numbers this step computed, never estimate its own.',
      },
      { nodeId: 'report', title: 'Write the health report', what: 'Writes the numbers, the blocked list, and the load picture as a simple HTML page.' },
      { nodeId: 'publish', title: 'Publish to Confluence', what: 'Creates the report page in the configured space.' },
      { nodeId: 'out', title: 'Return the report', what: 'Returns the tallies and the created page as named results.' },
    ],
    failureHandling:
      'The Jira query retries twice and fails the run rather than publishing a report over partial data. Publishing retries twice and fails loudly — a missing mid-sprint page should be noticed.',
    setup: [
      { label: 'Set the space key on the Publish to Confluence step', kind: 'value', ref: 'publish' },
      { label: 'Narrow the JQL to your project on the Query the open sprint step if the site is shared', kind: 'value', ref: 'pull' },
      { label: 'Check the Wednesday 09:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the day to match your sprint midpoint — Wednesday assumes a Monday start.',
      'Add sprint dates to the page title so the history reads chronologically.',
      'Add a Slack step after publishing to drop the page link in the team channel.',
    ],
    testPlan:
      'Run it by hand mid-sprint. Check the total in the report equals the JQL result count in Jira, and that every issue named as blocked is genuinely sitting untouched.',
  },
}

export const MONDAY_BOARD_SNAPSHOT: FlowTemplateDef = {
  id: 'monday-board-snapshot',
  name: 'Monday.com boards snapshot',
  description:
    'Every Monday morning, list your Monday.com boards, have AI write the one-screen status snapshot across them, and email it to whoever asks "where are we on everything?"',
  category: 'Team Cadence',
  icon: '📋',
  integrations: ['monday', 'email'],
  tags: ['weekly', 'monday', 'digest', 'status'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'monday', time: '08:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'boards',
        type: 'tool',
        data: {
          label: 'List the boards',
          connectionId: '',
          toolName: 'monday_list_boards',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the workspace\'s boards and their column structure — the shape of the work, refreshed at run time.',
        },
      },
      {
        id: 'snapshot',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the snapshot',
          input: '{{step.boards.output}}',
          instructions:
            'Write a one-screen Monday-morning snapshot of these Monday.com boards. Name each board exactly as given with one line on what it tracks, judged from its name and columns. Lead with the board count. Flat and scannable — no invented status, progress, or dates: describe only what the board data shows.',
          note: 'The board list carries names and structure, not item-level progress — so the instruction forbids inventing status the data does not contain.',
        },
      },
      {
        id: 'send',
        type: 'tool',
        data: {
          label: 'Email the snapshot',
          connectionId: '',
          toolName: 'send',
          args: '{"to":"","subject":"Monday boards snapshot","body":"{{step.snapshot.output}}"}',
          retries: 2,
          onError: 'continue',
          timeoutMs: 60000,
          note: 'Sends via the workspace email integration, and continues on error — the snapshot is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the snapshot',
          outputs: [{ name: 'snapshot', value: '{{step.snapshot.output}}', type: 'text' }],
          note: 'Named result, so a Slack flow can post the same snapshot without re-reading the boards.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'boards' },
      { id: 'e1', source: 'boards', target: 'snapshot' },
      { id: 'e2', source: 'snapshot', target: 'send' },
      { id: 'e3', source: 'send', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'boards',
      kind: 'connection',
      label: 'Pick the Monday.com account to read boards from',
      match: { provider: 'monday', toolName: 'monday_list_boards' },
    },
    {
      nodeId: 'send',
      kind: 'connection',
      label: 'Pick the email integration that sends the snapshot',
      match: { provider: 'email', toolName: 'send' },
    },
  ],
  notes: {
    objective:
      'The "where are we on everything?" question gets answered by email before it is asked, from the live board list rather than someone\'s Friday memory. It worked if the Monday status meeting shrinks or disappears.',
    inputs: [],
    steps: [
      { nodeId: 'boards', title: 'List the boards', what: 'Reads the workspace\'s boards and their column structure.' },
      {
        nodeId: 'snapshot',
        title: 'Write the snapshot',
        what: 'Writes one line per board on what it tracks, from its name and columns only.',
        why: 'The board list has structure but not item progress — the instruction forbids inventing status, so the snapshot never claims more than the data shows.',
      },
      { nodeId: 'send', title: 'Email the snapshot', what: 'Sends it, and carries on if email is down.' },
      { nodeId: 'out', title: 'Return the snapshot', what: 'Returns the snapshot as a named result.' },
    ],
    failureHandling:
      'The board read retries twice and fails the run rather than mailing a snapshot of nothing. The email continues on error, and the snapshot still comes back as a named output.',
    setup: [
      { label: 'Set the recipient on the Email the snapshot step', kind: 'value', ref: 'send' },
      { label: 'Check the Monday 08:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Send to a distribution list for a leadership audience.',
      'Add a Slack step to post the same snapshot in the team channel.',
      'Swap the email for the last step of your own reporting flow — the snapshot is a named output.',
    ],
    testPlan:
      'Run it by hand and check every board named in the email exists in Monday.com, and that no line claims progress the board list cannot actually show.',
  },
}

export const ONBOARDING_KICKOFF: FlowTemplateDef = {
  id: 'onboarding-kickoff',
  name: 'Customer onboarding kickoff',
  description:
    'Type the new customer\'s name and kickoff date: the flow drafts a tailored onboarding checklist, files it as the master Asana task, and announces the kickoff in the customers channel.',
  category: 'Team Cadence',
  icon: '🚢',
  integrations: ['asana', 'slack'],
  tags: ['on-demand', 'asana', 'onboarding', 'customer-success'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [
              { name: 'customerName', type: 'string', required: true, description: 'The new customer.' },
              { name: 'accountOwner', type: 'string', required: true, description: 'Who owns the onboarding.' },
              { name: 'kickoffDate', type: 'string', required: true, description: 'Kickoff date, as YYYY-MM-DD.' },
            ],
          },
        },
      },
      {
        id: 'plan',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Draft the onboarding checklist',
          input: 'Customer: {{trigger.input.customerName}}\nOwner: {{trigger.input.accountOwner}}\nKickoff: {{trigger.input.kickoffDate}}',
          instructions:
            'Draft an onboarding checklist for this new customer as a flat list of concrete tasks in delivery order: kickoff call, access and provisioning, first-value milestone, thirty-day check-in. Each task one line, starting with a verb. No dates beyond the kickoff date given, and no owners other than the one named.',
          note: 'The checklist rides inside the Asana task as its description — the team refines it there, which is where refinement belongs.',
        },
      },
      {
        id: 'task',
        type: 'tool',
        data: {
          label: 'File the master Asana task',
          connectionId: '',
          toolName: 'asana_create_task',
          args:
            '{"project":"","name":"Onboard {{trigger.input.customerName}}","notes":"Owner: {{trigger.input.accountOwner}}\\nKickoff: {{trigger.input.kickoffDate}}\\n\\n{{step.plan.output}}","due_on":"{{trigger.input.kickoffDate}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'One master task carrying the whole checklist, due on kickoff day. The task is created before the announcement so the channel post refers to work that already exists.',
        },
      },
      {
        id: 'announce',
        type: 'tool',
        data: {
          label: 'Announce the kickoff',
          connectionId: '',
          toolName: 'post_message',
          args:
            '{"channel":"#customers","text":"New customer kickoff: {{trigger.input.customerName}}, owned by {{trigger.input.accountOwner}}, kickoff {{trigger.input.kickoffDate}}. Onboarding task is filed in Asana."}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the task already exists, so a Slack outage must not fail the kickoff.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the kickoff record',
          outputs: [
            { name: 'task', value: '{{step.task.output}}', type: 'any' },
            { name: 'checklist', value: '{{step.plan.output}}', type: 'text' },
          ],
          note: 'Named results, so a CRM flow can attach the task link to the account record.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'plan' },
      { id: 'e1', source: 'plan', target: 'task' },
      { id: 'e2', source: 'task', target: 'announce' },
      { id: 'e3', source: 'announce', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'task',
      kind: 'connection',
      label: 'Pick the Asana workspace to file onboarding tasks in',
      match: { provider: 'asana', toolName: 'asana_create_task' },
    },
    {
      nodeId: 'announce',
      kind: 'connection',
      label: 'Pick the Slack workspace to announce kickoffs in',
      match: { provider: 'slack', toolName: 'post_message' },
    },
  ],
  notes: {
    objective:
      'Every new customer\'s onboarding starts the same way within a minute of the deal closing: a filed checklist with an owner and a date, and a team that knows about it. It worked if no customer\'s onboarding starts late because setting it up was someone\'s side task.',
    inputs: [
      { name: 'customerName', description: 'The new customer.', example: 'Acme Industries' },
      { name: 'accountOwner', description: 'Who owns the onboarding.', example: 'Sam Rivera' },
      { name: 'kickoffDate', description: 'Kickoff date, as YYYY-MM-DD.', example: '2026-09-01' },
    ],
    steps: [
      {
        nodeId: 'plan',
        title: 'Draft the onboarding checklist',
        what: 'Drafts a verb-first task list from kickoff call through the thirty-day check-in.',
        why: 'A draft in the task description, because the team will refine it in Asana — the flow\'s job is that the list exists on day zero.',
      },
      { nodeId: 'task', title: 'File the master Asana task', what: 'Creates one task named for the customer, carrying the checklist, due on kickoff day.' },
      { nodeId: 'announce', title: 'Announce the kickoff', what: 'Posts the customer, owner, and date to the channel, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the kickoff record', what: 'Returns the created task and the checklist as named results.' },
    ],
    failureHandling:
      'Task creation retries twice and fails the run loudly — an announced kickoff with no task behind it is exactly the failure mode this flow replaces. The announcement continues on error because the task already exists.',
    setup: [
      { label: 'Set the Asana project gid on the File the master Asana task step', kind: 'value', ref: 'task' },
      { label: 'Set the channel name on the Announce the kickoff step', kind: 'value', ref: 'announce' },
    ],
    customize: [
      'Edit the checklist stages in the drafting instruction to match your delivery motion.',
      'Add a Gmail step to send the customer-facing welcome email once the internal side is trusted.',
      'Create per-stage subtasks with additional Asana steps if one master task is too coarse.',
    ],
    testPlan:
      'Run it with a test customer name. Check the Asana task lands in the right project with the checklist in its description and the kickoff date as its due date, and that the announcement names the same owner.',
  },
}

export const WEEKLY_EXEC_BRIEF: FlowTemplateDef = {
  id: 'weekly-exec-brief',
  name: 'Friday exec brief, two channels',
  description:
    'Every Friday afternoon, pull the live pipeline from Backstory, have your Sales Digest agent write the executive brief, and deliver it twice — posted to the leadership channel and emailed to the distribution list.',
  category: 'Team Cadence',
  icon: '🧭',
  integrations: ['backstory', 'slack', 'email'],
  tags: ['weekly', 'agents', 'executive', 'digest'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'friday', time: '15:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull the pipeline from Backstory',
          connectionId: '',
          toolName: 'top_records',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads your most relevant accounts and opportunities so the brief is grounded in the live record, not the week\'s hallway impressions.',
        },
      },
      {
        id: 'brief',
        type: 'agent',
        data: {
          label: 'Write the executive brief',
          agentId: '',
          input:
            'Write this week\'s executive brief from the pipeline below. Where the number stands, what moved, the two deals that matter most, and the one risk leadership should know about. Under 300 words.\n\nPipeline:\n{{step.pull.output}}',
          includeUpstreamContext: true,
          retries: 1,
          timeoutMs: 300000,
          note: 'Delegated to your Sales Digest agent rather than an inline prompt, so the brief inherits the agent\'s tools and improves whenever the agent does.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the leadership channel',
          connectionId: '',
          toolName: 'post_message',
          args: '{"channel":"#leadership","text":"{{step.brief.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Continues on error — the two deliveries are independent, and either alone still lands the brief.',
        },
      },
      {
        id: 'send',
        type: 'tool',
        data: {
          label: 'Email the distribution list',
          connectionId: '',
          toolName: 'send',
          args: '{"to":"","subject":"Weekly exec brief","body":"{{step.brief.output}}"}',
          retries: 2,
          onError: 'continue',
          timeoutMs: 60000,
          note: 'Also continues on error, for the same reason: the brief is returned as a named result below whatever the channels do.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the brief',
          outputs: [{ name: 'brief', value: '{{step.brief.output}}', type: 'text' }],
          note: 'Named result, so board-prep or all-hands flows can reuse the same brief without re-running the agent.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'brief' },
      { id: 'e2', source: 'brief', target: 'post' },
      { id: 'e3', source: 'post', target: 'send' },
      { id: 'e4', source: 'send', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Backstory connection to read the pipeline from',
      match: { provider: 'backstory', toolName: 'top_records' },
    },
    {
      nodeId: 'brief',
      kind: 'agent',
      label: 'Pick the agent that writes the executive brief',
      match: { agentName: 'Sales Digest' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace with the leadership channel',
      match: { provider: 'slack', toolName: 'post_message' },
    },
    {
      nodeId: 'send',
      kind: 'connection',
      label: 'Pick the email integration for the distribution list',
      match: { provider: 'email', toolName: 'send' },
    },
  ],
  notes: {
    objective:
      'Leadership gets the same grounded brief every Friday in both places they read — channel and inbox — written by the agent that already knows how your team talks about pipeline. It worked if Monday\'s leadership meeting starts from this brief.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Pull the pipeline from Backstory', what: 'Reads your most relevant accounts and opportunities.' },
      {
        nodeId: 'brief',
        title: 'Write the executive brief',
        what: 'Hands the pipeline to your Sales Digest agent for the under-300-word leadership version.',
        why: 'An agent rather than an inline prompt, so the brief improves whenever you improve the agent — without editing this flow.',
      },
      { nodeId: 'post', title: 'Post to the leadership channel', what: 'Delivers to Slack, and carries on if Slack is down.' },
      { nodeId: 'send', title: 'Email the distribution list', what: 'Delivers the same brief by email, and carries on if email is down.' },
      { nodeId: 'out', title: 'Return the brief', what: 'Returns the brief as a named result.' },
    ],
    failureHandling:
      'The pipeline read retries twice and fails the run — a brief over no data must not go out looking authoritative. Both deliveries continue on error independently, so one channel\'s outage never blocks the other, and the brief always comes back as a named output.',
    setup: [
      { label: 'Set the channel name on the Post to the leadership channel step', kind: 'value', ref: 'post' },
      { label: 'Set the recipient on the Email the distribution list step', kind: 'value', ref: 'send' },
      { label: 'Check the Friday 15:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Swap the Sales Digest agent for your own brief-writer — the flow only needs text back.',
      'Drop either delivery step if leadership reads only one channel.',
      'Change the word cap and emphasis by editing the message on the Write the executive brief step.',
    ],
    testPlan:
      'Run it by hand on a Thursday. Check every number in the brief traces to the pipeline read, then confirm both deliveries landed — and that a deliberately wrong channel name still leaves the email and the named output intact.',
  },
}
