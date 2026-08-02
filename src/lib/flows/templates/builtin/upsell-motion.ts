import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * The composition showcase: a flow whose thinking step IS an agent from the
 * template gallery.
 *
 * The other built-ins reason with inline `ai` steps, which are self-contained
 * but have no tools, no memory, and no instructions of their own. Here the
 * per-account scoring is delegated to the "Upsell Account Scorer" agent
 * template, bound by name — so a workspace that deployed that agent gets this
 * flow wired end to end on instantiate, and the flow inherits whatever tools and
 * judgement the agent already has. Everything around it stays deterministic:
 * the pull, the threshold, and the ranking are steps a model never touches.
 */
export const UPSELL_MOTION: FlowTemplateDef = {
  id: 'upsell-motion',
  name: 'Upsell motion (agent-scored)',
  description:
    'Weekly: pull your top accounts from Backstory, hand each one to your Upsell Account Scorer agent, keep the ones that clear the readiness bar, rank them, and post the shortlist to your sales channel.',
  category: 'Pipeline & Forecasting',
  icon: '🚀',
  integrations: ['backstory', 'slack'],
  tags: ['weekly', 'agents', 'scoring', 'pipeline'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'monday', time: '07:30', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull top accounts from Backstory',
          connectionId: '',
          toolName: 'top_records',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads your most relevant accounts straight from Backstory — no CRM credentials to configure, because the connection you already use for account data is the one this step calls.',
        },
      },
      {
        id: 'score',
        type: 'agent',
        data: {
          label: 'Score each account for upsell readiness',
          agentId: '',
          input:
            'Score this account for upsell readiness. Return the readiness score, the primary use case that fits, and the single biggest risk.\n\nAccount: {{item}}',
          responseFormat: 'structured',
          outputFields: [
            { name: 'account', type: 'string' },
            { name: 'score', type: 'number' },
            { name: 'primaryUseCase', type: 'string' },
            { name: 'risk', type: 'string' },
          ],
          perItem: { over: '{{step.pull.output.result}}', itemError: 'collect', concurrency: 4 },
          retries: 1,
          note: 'One agent run per account, four at a time. The agent brings its own tools and instructions, so this step improves whenever you improve the agent — without editing the flow. Failures are collected per account, so one unscorable record cannot cost you the weekly run.',
        },
      },
      {
        id: 'ready',
        type: 'data',
        data: {
          op: 'filterArray',
          label: 'Keep the ready ones',
          input: '{{step.score.output}}',
          clauses: [{ left: '{{item.score}}', op: 'gte', right: '70' }],
          note: 'Seventy and above only. Deterministic — no model call — so the bar is auditable and cannot drift week to week, however the agent phrases its reasoning.',
        },
      },
      {
        id: 'rank',
        type: 'code',
        data: {
          label: 'Rank and cap the shortlist',
          language: 'javascript',
          mode: 'all',
          input: '{{step.ready.output}}',
          timeoutMs: 10000,
          code: [
            'const rows = Array.isArray(input) ? input : []',
            'return rows',
            '  .filter((row) => row && typeof row.score === "number")',
            '  .sort((a, b) => b.score - a.score)',
            '  .slice(0, 10)',
            '  .map((row, index) => ({ rank: index + 1, account: row.account, score: row.score, useCase: row.primaryUseCase, risk: row.risk }))',
          ].join('\n'),
          note: 'Sorting and capping at 10 is arithmetic, not judgement — a code step does it identically every week, where a model would not.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the shortlist post',
          input: '{{step.rank.output}}',
          instructions:
            'Write a short channel post for the sales team. Lead with how many accounts cleared the bar, then the top three with their use case and their one risk. Under 150 words. State the counts exactly as given and add nothing that is not in the list.',
          note: 'The model only writes prose here — every account, score, and count it quotes was produced by the steps above, so it has nothing left to invent.',
        },
      },
      {
        id: 'notify',
        type: 'tool',
        data: {
          label: 'Post the shortlist to Slack',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#sales","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: a Slack outage should not lose the week\'s shortlist, which is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the shortlist',
          outputs: [
            { name: 'shortlist', value: '{{step.rank.output}}', type: 'list' },
            { name: 'post', value: '{{step.digest.output}}', type: 'text' },
          ],
          note: 'Named results, so another flow can run this one as a step and take the ranked shortlist straight from it.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'score' },
      { id: 'e2', source: 'score', target: 'ready' },
      { id: 'e3', source: 'ready', target: 'rank' },
      { id: 'e4', source: 'rank', target: 'digest' },
      { id: 'e5', source: 'digest', target: 'notify' },
      { id: 'e6', source: 'notify', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Backstory connection to read accounts from',
      match: { provider: 'backstory', toolName: 'top_records' },
    },
    {
      nodeId: 'score',
      kind: 'agent',
      label: 'Pick the agent that scores upsell readiness',
      match: { agentName: 'Upsell Account Scorer' },
    },
    {
      nodeId: 'notify',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the shortlist to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Every Monday, put a ranked shortlist of the accounts most ready for an upsell conversation in front of the sales team, scored by your own agent rather than by a one-off prompt. It worked if the post names a real count and a rep agrees the top three are worth a call this week.',
    inputs: [],
    steps: [
      {
        nodeId: 'pull',
        title: 'Pull top accounts from Backstory',
        what: 'Reads your most relevant accounts from the Backstory connection.',
        why: 'Using Backstory rather than a raw CRM call means there is no API address or credential to configure before the first run.',
      },
      {
        nodeId: 'score',
        title: 'Score each account for upsell readiness',
        what: 'Hands each account to your Upsell Account Scorer agent and collects a score, the fitting use case, and the biggest risk.',
        why: 'The scoring lives in an agent, not in this flow, so improving the agent improves every run without anyone editing the graph.',
      },
      { nodeId: 'ready', title: 'Keep the ready ones', what: 'Drops every account scoring below 70.' },
      {
        nodeId: 'rank',
        title: 'Rank and cap the shortlist',
        what: 'Sorts by score and keeps the top 10.',
        why: 'Sorting is arithmetic — a code step does it the same way every week, where a model would not.',
      },
      { nodeId: 'digest', title: 'Write the shortlist post', what: 'Turns the ranked shortlist into a short channel post.' },
      { nodeId: 'notify', title: 'Post the shortlist to Slack', what: 'Sends the post to your sales channel, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the shortlist', what: 'Returns the ranked shortlist and the post as named results.' },
    ],
    decisionRules:
      'An account reaches the shortlist at a readiness score of 70 or above, and only the top 10 by score are posted. The score itself comes from the agent — change how it is judged by editing the agent, and change the bar by editing the Keep the ready ones step.',
    failureHandling:
      'The account pull retries twice before failing the run, so a broken connection is loud rather than quietly producing an empty shortlist. Per-account scoring collects failures instead of aborting, and each account retries once. Posting to Slack continues on error — the shortlist is still returned as a named output.',
    // The three bindings above already ask for the Backstory connection, the
    // scoring agent, and Slack — listing them again here would double-count them
    // in the setup checklist, so this covers only what a binding cannot fill.
    setup: [
      { label: 'Set the channel name on the Post the shortlist to Slack step', kind: 'value', ref: 'notify' },
      { label: 'Check the Monday 07:30 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the readiness bar off 70 once you have seen how your accounts actually score.',
      'Swap the scoring agent for any agent of your own — the rest of the flow does not care which one it is, only that it returns a score.',
      'Change the top-10 cap in Rank and cap the shortlist.',
      'Add a second delivery step after the Slack post to email the shortlist to leadership.',
    ],
    testPlan:
      'Leave the flow as a draft and run it once by hand. Check that the account pull returns records, that the number of scores matches the number of accounts, and that the post quotes the same count as the filtered list before you switch the schedule on.',
  },
}
