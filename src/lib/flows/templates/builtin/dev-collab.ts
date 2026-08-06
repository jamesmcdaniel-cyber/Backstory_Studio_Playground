import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Engineering & design pipelines — the GitHub / Linear / Figma corner of the
 * catalogue. Each one pulls from a dev tool with a deterministic read, reasons
 * with an inline AI step, and delivers somewhere a team already looks. They
 * exist to show the catalogue is not sales-only: the same graph shapes carry
 * an engineering standup as well as a pipeline digest.
 */

export const GITHUB_STANDUP_DIGEST: FlowTemplateDef = {
  id: 'github-standup-digest',
  name: 'Open PR standup digest',
  description:
    'Every weekday morning, pull the open pull requests on your main repository, have AI write the two-minute standup summary, and post it to the engineering channel before the standup starts.',
  category: 'Engineering & Design',
  icon: '🔀',
  integrations: ['github', 'slack'],
  tags: ['daily', 'github', 'engineering', 'digest'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '08:30', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'List open pull requests',
          connectionId: '',
          toolName: 'github_list_pull_requests',
          args: '{"owner":"","repo":"","state":"open"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the open PRs straight from GitHub. Retried twice — a standup post built on a failed read is worse than a late one.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the standup summary',
          input: '{{step.pull.output}}',
          instructions:
            'Write a short standup summary of these open pull requests. Lead with the count, then group by what needs attention: waiting on review, recently updated, and untouched for days. Name the PR titles and authors exactly as given — never invent one.',
          note: 'The model only arranges what the read above returned — every PR title and author it mentions is in that output, so there is nothing to hallucinate.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the engineering channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#engineering","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: a Slack outage should not lose the digest, which is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the digest',
          outputs: [{ name: 'digest', value: '{{step.digest.output}}', type: 'text' }],
          note: 'Named result, so another flow can run this one as a step and reuse the summary.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'digest' },
      { id: 'e2', source: 'digest', target: 'post' },
      { id: 'e3', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the GitHub account to read pull requests from',
      match: { provider: 'github', toolName: 'github_list_pull_requests' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the digest to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Have the open-PR picture in the engineering channel before standup, so the meeting starts from the list instead of building it. It worked if nobody opens GitHub during standup to check what is in flight.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'List open pull requests', what: 'Reads the open PRs on the configured repository from GitHub.' },
      {
        nodeId: 'digest',
        title: 'Write the standup summary',
        what: 'Groups the PRs by what needs attention and writes the two-minute version.',
        why: 'One summary over the whole list, because what matters at standup is the shape of the queue, not any single PR.',
      },
      { nodeId: 'post', title: 'Post to the engineering channel', what: 'Sends the summary to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the digest', what: 'Returns the summary as a named result.' },
    ],
    failureHandling:
      'The GitHub read retries twice and fails the run if it cannot succeed, so an empty digest is never posted as though the queue were clear. Posting to Slack continues on error, and the digest still comes back as a named output.',
    setup: [
      { label: 'Set the owner and repo on the List open pull requests step', kind: 'value', ref: 'pull' },
      { label: 'Set the channel name on the Post to the engineering channel step', kind: 'value', ref: 'post' },
      { label: 'Check the 08:30 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Point the read at a different repository, or duplicate the read step to cover several.',
      'Change what the summary emphasises by editing the instruction on the Write the standup summary step.',
      'Switch the trigger to weekly if a daily post is too chatty for your team.',
    ],
    testPlan:
      'Run it by hand once. Check the read returns your actual open PRs and that every title in the summary appears in that output before you switch the schedule on.',
  },
}

export const GITHUB_STALE_PR_NUDGE: FlowTemplateDef = {
  id: 'github-stale-pr-nudge',
  name: 'Stale PR nudge',
  description:
    'Every Friday, find the pull requests that have sat open for more than a week, and post a friendly nudge naming each one and its author — or stay silent when the queue is clean.',
  category: 'Engineering & Design',
  icon: '⏰',
  integrations: ['github', 'slack'],
  tags: ['weekly', 'github', 'engineering', 'hygiene'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'friday', time: '09:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'List open pull requests',
          connectionId: '',
          toolName: 'github_list_pull_requests',
          args: '{"owner":"","repo":"","state":"open"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads every open PR; the age cut happens in the next step, deterministically, not in the model.',
        },
      },
      {
        id: 'stale',
        type: 'code',
        data: {
          label: 'Keep PRs older than a week',
          language: 'javascript',
          mode: 'all',
          input: '{{step.pull.output}}',
          timeoutMs: 10000,
          code: [
            'const prs = Array.isArray(input) ? input : []',
            'const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000',
            'return prs',
            '  .filter((pr) => pr && pr.created_at && new Date(pr.created_at).getTime() < weekAgo)',
            '  .map((pr) => ({ title: pr.title, author: pr.user && pr.user.login, url: pr.html_url, openedAt: pr.created_at }))',
          ].join('\n'),
          note: 'Age is arithmetic, so a code step decides it — the seven-day bar cannot drift with a model\'s mood.',
        },
      },
      {
        id: 'any',
        type: 'condition',
        data: {
          label: 'Anything stale?',
          clauses: [{ left: '{{step.stale.output}}', op: 'isNotEmpty', right: '' }],
          note: 'A clean queue ends the run silently — a weekly "nothing to report" post trains everyone to ignore the channel.',
        },
      },
      {
        id: 'nudge',
        type: 'ai',
        data: {
          aiOp: 'ask',
          label: 'Write the nudge',
          input: '{{step.stale.output}}',
          instructions:
            'Write a short, friendly channel post nudging these stale pull requests. Name each PR, its author, and how long it has been open, with its link. No blame — the tone is "let\'s unstick these", not "you failed".',
          note: 'The model writes prose over the filtered list only — it never decides what counts as stale.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post the nudge',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#engineering","text":"{{step.nudge.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the stale list is still returned as a named result even if Slack is down.',
        },
      },
      {
        id: 'clean',
        type: 'stop',
        data: {
          label: 'Queue is clean',
          reason: 'No pull request has been open for more than a week — nothing to nudge.',
          note: 'Stopping early is deliberate: the run still shows in history, so you can confirm the check ran.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the stale list',
          outputs: [{ name: 'stalePrs', value: '{{step.stale.output}}', type: 'list' }],
          note: 'Named result, so a dashboard or another flow can track how the stale count trends week to week.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'stale' },
      { id: 'e2', source: 'stale', target: 'any' },
      { id: 'e3', source: 'any', target: 'nudge', branch: 'true' },
      { id: 'e4', source: 'any', target: 'clean', branch: 'false' },
      { id: 'e5', source: 'nudge', target: 'post' },
      { id: 'e6', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the GitHub account to read pull requests from',
      match: { provider: 'github', toolName: 'github_list_pull_requests' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the nudge in',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Keep review debt from quietly accumulating: every Friday, anything open more than a week gets named, and a clean week posts nothing. It worked if the stale count trends down and the channel does not learn to ignore the post.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'List open pull requests', what: 'Reads every open PR on the configured repository.' },
      {
        nodeId: 'stale',
        title: 'Keep PRs older than a week',
        what: 'Filters to PRs opened more than seven days ago and keeps title, author, link, and age.',
        why: 'Age is arithmetic — a code step applies the same bar every week, where a model would not.',
      },
      { nodeId: 'any', title: 'Anything stale?', what: 'Ends the run silently when the filtered list is empty.' },
      { nodeId: 'nudge', title: 'Write the nudge', what: 'Turns the stale list into a friendly, named channel post.' },
      { nodeId: 'post', title: 'Post the nudge', what: 'Sends it to Slack, and carries on if Slack is down.' },
      { nodeId: 'clean', title: 'Queue is clean', what: 'Stops the run when there is nothing older than a week.' },
      { nodeId: 'out', title: 'Return the stale list', what: 'Returns the stale PRs as a named result.' },
    ],
    decisionRules:
      'A pull request is stale after seven days open. A clean queue posts nothing at all — silence is the reward. Change the bar by editing the day arithmetic in Keep PRs older than a week.',
    failureHandling:
      'The GitHub read retries twice and fails the run rather than posting from partial data. Posting to Slack continues on error — the stale list still comes back as a named output.',
    setup: [
      { label: 'Set the owner and repo on the List open pull requests step', kind: 'value', ref: 'pull' },
      { label: 'Set the channel name on the Post the nudge step', kind: 'value', ref: 'post' },
    ],
    customize: [
      'Change the seven-day bar in Keep PRs older than a week.',
      'Add a second read step to cover another repository and merge the lists before the filter.',
      'Route the nudge to each author as a direct message instead of one channel post.',
    ],
    testPlan:
      'Run it by hand mid-week. If your queue is clean, temporarily lower the bar to one day to see the nudge path fire, check every PR named is real, then put the bar back.',
  },
}

export const BUG_INTAKE_TO_LINEAR: FlowTemplateDef = {
  id: 'bug-intake-to-linear',
  name: 'Bug report intake to Linear',
  description:
    'Take a raw bug report from a webhook, extract the severity and a clean summary, file it as a Linear issue, and page the team channel when it is critical.',
  category: 'Engineering & Design',
  icon: '🐞',
  integrations: ['linear', 'slack'],
  tags: ['webhook', 'linear', 'triage', 'real-time'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'webhook',
            inputFields: [
              { name: 'title', type: 'string', required: true, description: 'Short title of the bug.' },
              { name: 'details', type: 'string', required: true, description: 'What happened, in the reporter\'s words.' },
              { name: 'reporter', type: 'string', required: false, description: 'Who reported it.' },
            ],
          },
        },
      },
      {
        id: 'extract',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Extract severity and summary',
          input: 'Title: {{trigger.input.title}}\n\nDetails: {{trigger.input.details}}',
          instructions:
            'Read the bug report and extract: severity as exactly one of critical, high, or normal (critical means data loss, security, or a hard outage); a one-paragraph clean summary an engineer can act on; and the affected area if named. Never upgrade severity beyond what the report supports.',
          outputFields: [
            { name: 'severity', type: 'string' },
            { name: 'summary', type: 'string' },
            { name: 'area', type: 'string' },
          ],
          note: 'A fixed severity vocabulary means the branch below can compare exactly — the model picks one of three, it does not invent a fourth.',
        },
      },
      {
        id: 'file',
        type: 'tool',
        data: {
          label: 'File the Linear issue',
          connectionId: '',
          toolName: 'linear_create_issue',
          args:
            '{"teamId":"","title":"{{trigger.input.title}}","description":"Severity: {{step.extract.output.severity}}\\nReported by: {{trigger.input.reporter}}\\n\\n{{step.extract.output.summary}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'The issue is filed for every report, whatever the severity — the branch below only decides whether anyone gets paged about it.',
        },
      },
      {
        id: 'critical',
        type: 'condition',
        data: {
          label: 'Is it critical?',
          clauses: [{ left: '{{step.extract.output.severity}}', op: 'eq', right: 'critical', ignoreCase: true }],
          note: 'Only critical pages the channel. High and normal are in Linear where triage will find them — paging for everything teaches the channel to ignore pages.',
        },
      },
      {
        id: 'page',
        type: 'tool',
        data: {
          label: 'Page the team channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#eng-urgent","text":"Critical bug filed: {{trigger.input.title}} — {{step.extract.output.summary}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the issue is already filed, so a Slack outage must not fail the intake.',
        },
      },
      {
        id: 'merge',
        type: 'join',
        data: {
          label: 'Converge the paths',
          note: 'Passthrough join: only one branch arrives — either the page result or nothing extra — and the output below reads from named steps either way.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the filed issue',
          outputs: [
            { name: 'severity', value: '{{step.extract.output.severity}}', type: 'text' },
            { name: 'issue', value: '{{step.file.output}}', type: 'any' },
          ],
          note: 'The webhook caller gets the severity and the created issue back, so the reporting system can link to it.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'extract' },
      { id: 'e1', source: 'extract', target: 'file' },
      { id: 'e2', source: 'file', target: 'critical' },
      { id: 'e3', source: 'critical', target: 'page', branch: 'true' },
      { id: 'e4', source: 'critical', target: 'merge', branch: 'false' },
      { id: 'e5', source: 'page', target: 'merge' },
      { id: 'e6', source: 'merge', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'file',
      kind: 'connection',
      label: 'Pick the Linear workspace to file issues in',
      match: { provider: 'linear', toolName: 'linear_create_issue' },
    },
    {
      nodeId: 'page',
      kind: 'connection',
      label: 'Pick the Slack workspace to page for critical bugs',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Every bug report becomes a clean, severity-tagged Linear issue the moment it arrives, and only the critical ones interrupt anyone. It worked if triage stops rewriting raw reports and the urgent channel only ever sees real emergencies.',
    inputs: [
      { name: 'title', description: 'Short title of the bug.', example: 'Export button 500s on large workspaces' },
      { name: 'details', description: 'What happened, in the reporter\'s words.' },
      { name: 'reporter', description: 'Who reported it — recorded on the issue.', example: 'support@acme.com' },
    ],
    steps: [
      {
        nodeId: 'extract',
        title: 'Extract severity and summary',
        what: 'Pulls a severity from a fixed three-value list, a clean summary, and the affected area out of the raw report.',
        why: 'A closed severity vocabulary means the branch can compare exactly instead of pattern-matching free text.',
      },
      { nodeId: 'file', title: 'File the Linear issue', what: 'Creates the issue with the severity, reporter, and clean summary in the description.' },
      { nodeId: 'critical', title: 'Is it critical?', what: 'Routes critical reports to the page; everything else finishes quietly.' },
      { nodeId: 'page', title: 'Page the team channel', what: 'Posts the critical bug to the urgent channel, and carries on if Slack is down.' },
      { nodeId: 'merge', title: 'Converge the paths', what: 'Brings both branches back to one path for the output.' },
      { nodeId: 'out', title: 'Return the filed issue', what: 'Returns the severity and the created issue to the webhook caller.' },
    ],
    decisionRules:
      'Critical means data loss, a security problem, or a hard outage — and only critical pages the channel. The extractor is told never to upgrade severity beyond what the report supports, so borderline reports under-page rather than over-page.',
    failureHandling:
      'Filing the issue retries twice and fails the run if Linear is unreachable — a bug report must never be silently dropped. The page continues on error because the issue already exists by then.',
    setup: [
      { label: 'Set the Linear team id on the File the Linear issue step', kind: 'value', ref: 'file' },
      { label: 'Set the channel name on the Page the team channel step', kind: 'value', ref: 'page' },
      { label: 'Copy the webhook address from the trigger into the system that reports bugs', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Add severities to the extraction instruction — then add matching cases if you want more than one alert path.',
      'Route critical bugs to an on-call rotation instead of a channel.',
      'Add a duplicate check before filing, if your reporters tend to double-send.',
    ],
    testPlan:
      'Post one obviously-critical and one routine report to the webhook address. Check both land in Linear with sensible severities and that only the critical one paged the channel.',
  },
}

export const FIGMA_REVIEW_DIGEST: FlowTemplateDef = {
  id: 'figma-review-digest',
  name: 'Design feedback digest',
  description:
    'Every evening, read the comments on your main Figma file, have AI pull out the open questions and decisions, and post the digest to the design channel.',
  category: 'Engineering & Design',
  icon: '🎨',
  integrations: ['figma', 'slack'],
  tags: ['daily', 'figma', 'design', 'digest'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '17:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'comments',
        type: 'tool',
        data: {
          label: 'Read the file comments',
          connectionId: '',
          toolName: 'figma_get_comments',
          args: '{"fileKey":""}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads every comment thread on the configured file. The digest step decides what is still open — this step just fetches faithfully.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Pull out open questions and decisions',
          input: '{{step.comments.output}}',
          instructions:
            'Summarize this Figma comment thread data for the design team. Lead with unresolved questions that block someone, then decisions made today, then everything else in one line. Attribute comments to their authors exactly as given. If there are no comments, say the file was quiet today.',
          note: 'The model reads real comment data and arranges it — authors and quotes come from the fetch above, never from memory.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the design channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#design","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the digest is still returned as a named result even when Slack is down.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the digest',
          outputs: [{ name: 'digest', value: '{{step.digest.output}}', type: 'text' }],
          note: 'Named result, so a weekly roll-up flow can collect a week of these evening digests.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'comments' },
      { id: 'e1', source: 'comments', target: 'digest' },
      { id: 'e2', source: 'digest', target: 'post' },
      { id: 'e3', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'comments',
      kind: 'connection',
      label: 'Pick the Figma account to read comments from',
      match: { provider: 'figma', toolName: 'figma_get_comments' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the digest to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Nobody should have to trawl Figma threads to find out what got decided today. It worked if open questions surface in the channel the same evening instead of being rediscovered days later inside a thread.',
    inputs: [],
    steps: [
      { nodeId: 'comments', title: 'Read the file comments', what: 'Fetches every comment thread on the configured Figma file.' },
      {
        nodeId: 'digest',
        title: 'Pull out open questions and decisions',
        what: 'Sorts the threads into blocking questions, decisions made, and the rest.',
        why: 'Open-versus-decided is a judgement over the whole thread, which is exactly the part worth delegating to the model.',
      },
      { nodeId: 'post', title: 'Post to the design channel', what: 'Sends the digest to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the digest', what: 'Returns the digest as a named result.' },
    ],
    failureHandling:
      'The Figma read retries twice and fails the run rather than posting a digest from nothing. Posting continues on error, and the digest still comes back as a named output.',
    setup: [
      { label: 'Set the Figma file key on the Read the file comments step', kind: 'value', ref: 'comments' },
      { label: 'Set the channel name on the Post to the design channel step', kind: 'value', ref: 'post' },
      { label: 'Check the 17:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Duplicate the read step to cover several files and merge before the digest.',
      'Change what the digest leads with by editing the instruction — decisions first, for a team that resolves quickly.',
      'Switch to a weekly cadence for slower-moving files.',
    ],
    testPlan:
      'Run it by hand on a file with a few real comment threads. Check every author and quote in the digest appears in the fetched comments before switching the schedule on.',
  },
}
