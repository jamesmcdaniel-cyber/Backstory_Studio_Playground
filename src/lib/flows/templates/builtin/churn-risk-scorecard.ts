import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * The flagship "this is why flow templates exist" pipeline: a paginated API
 * pull, a per-item AI score with error tolerance, a deterministic filter, a
 * code node doing the ranking, and a delivery step — none of which is
 * expressible as an agent prompt.
 */
export const CHURN_RISK_SCORECARD: FlowTemplateDef = {
  id: 'churn-risk-scorecard',
  name: 'Churn-risk scorecard',
  description:
    'Weekly: pull every open account from your CRM, score each one for churn risk, keep the ones above threshold, rank them, and post a digest to your team channel.',
  category: 'Customer Success',
  icon: '📉',
  integrations: ['Slack'],
  tags: ['weekly', 'scoring', 'customer-success'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'monday', time: '07:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'api-base',
        type: 'variable',
        data: {
          op: 'initialize',
          name: 'crmApiBase',
          varType: 'string',
          value: 'https://your-crm.example.com/api/v2',
          label: 'Set the CRM API address',
          note: 'Point this at your own CRM before the first real run. Every request below is built from it, so this is the only place the address appears.',
        },
      },
      {
        id: 'pull',
        type: 'http',
        data: {
          label: 'Pull open accounts',
          method: 'GET',
          url: '{{var.crmApiBase}}/accounts',
          sendQuery: true,
          query: '{"status":"open","per_page":"200"}',
          sendBody: false,
          bodyMode: 'none',
          failOnHttpError: true,
          retries: 2,
          timeoutMs: 30000,
          pagination: { mode: 'updateParam', param: 'page', start: 1, step: 1, itemsPath: 'data', maxPages: 20 },
          optimizeForAi: { fields: ['id', 'name', 'arr', 'renewal_date', 'last_activity_at', 'open_tickets'], maxItems: 500 },
          note: 'Walks up to 20 pages of 200 and stops early on the first empty page. Only the six fields the scorer needs survive, so a wide CRM record does not blow up the prompt.',
        },
      },
      {
        id: 'score',
        type: 'ai',
        data: {
          aiOp: 'score',
          label: 'Score churn risk',
          input: '{{item}}',
          instructions:
            'Rate this account\'s churn risk. Weigh a renewal inside 90 days, a long gap since last activity, and a rising open-ticket count as risk. Give the single strongest driver as the reason. Do not invent facts that are not in the record.',
          scoreMin: 1,
          scoreMax: 10,
          perItem: { over: '{{step.pull.output.body}}', itemError: 'collect', concurrency: 5 },
          note: 'One scoring call per account, five at a time. A malformed record leaves a placeholder rather than killing the whole weekly run.',
        },
      },
      {
        id: 'at-risk',
        type: 'data',
        data: {
          op: 'filterArray',
          label: 'Keep the at-risk ones',
          input: '{{step.score.output}}',
          clauses: [{ left: '{{item.score}}', op: 'gte', right: '7' }],
          note: 'Seven and above only. Deterministic — no model call — so the cutoff is auditable and cannot drift.',
        },
      },
      {
        id: 'rank',
        type: 'code',
        data: {
          label: 'Rank and cap the list',
          language: 'javascript',
          mode: 'all',
          input: '{{step.at-risk.output}}',
          timeoutMs: 10000,
          code: [
            'const rows = Array.isArray(input) ? input : []',
            'return rows',
            '  .filter((row) => row && typeof row.score === "number")',
            '  .sort((a, b) => b.score - a.score)',
            '  .slice(0, 15)',
            '  .map((row, index) => ({ rank: index + 1, score: row.score, reason: row.reason }))',
          ].join('\n'),
          note: 'Sorting and capping at 15 is arithmetic, not judgement — a code step does it exactly the same way every week, which a model would not.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the digest',
          input: '{{step.rank.output}}',
          instructions:
            'Write a short channel post for the customer-success team. Lead with how many accounts are at risk, then the top three with their single strongest driver. Under 150 words. State the counts exactly as given.',
          note: 'The model only writes prose here — every number it quotes was computed by the steps above, so it has nothing to invent.',
        },
      },
      {
        id: 'notify',
        type: 'tool',
        data: {
          label: 'Post to the team channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#customer-success","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: a Slack outage should not lose the scorecard, which is still returned below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the scorecard',
          outputs: [
            { name: 'atRisk', value: '{{step.rank.output}}', type: 'list' },
            { name: 'digest', value: '{{step.digest.output}}', type: 'text' },
          ],
          note: 'Named results, so another flow can run this one as a step and use the ranked list directly.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'api-base' },
      { id: 'e1', source: 'api-base', target: 'pull' },
      { id: 'e2', source: 'pull', target: 'score' },
      { id: 'e3', source: 'score', target: 'at-risk' },
      { id: 'e4', source: 'at-risk', target: 'rank' },
      { id: 'e5', source: 'rank', target: 'digest' },
      { id: 'e6', source: 'digest', target: 'notify' },
      { id: 'e7', source: 'notify', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'notify',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the digest to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Every Monday, produce a ranked list of the accounts most likely to churn and put it in front of the customer-success team. It worked if the channel post names a real count and the top three accounts are ones a CSM agrees are worth a call.',
    inputs: [],
    steps: [
      { nodeId: 'api-base', title: 'Set the CRM API address', what: 'Holds your CRM API address in one place, used by the request below.' },
      {
        nodeId: 'pull',
        title: 'Pull open accounts',
        what: 'Fetches every open account, following pages until one comes back empty, and keeps only the six fields the scorer needs.',
        why: 'Trimming the record before it reaches the model is what keeps a 500-account run affordable.',
      },
      {
        nodeId: 'score',
        title: 'Score churn risk',
        what: 'Rates each account 1-10 with the single strongest driver, five accounts at a time.',
        why: 'Errors are collected per account rather than failing the step, so one bad record cannot cost you the weekly run.',
      },
      { nodeId: 'at-risk', title: 'Keep the at-risk ones', what: 'Drops everything scoring below 7.' },
      {
        nodeId: 'rank',
        title: 'Rank and cap the list',
        what: 'Sorts by score and keeps the top 15.',
        why: 'Sorting is arithmetic — a code step does it identically every week, where a model would not.',
      },
      { nodeId: 'digest', title: 'Write the digest', what: 'Turns the ranked list into a short channel post.' },
      { nodeId: 'notify', title: 'Post to the team channel', what: 'Sends the digest to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the scorecard', what: 'Returns the ranked list and the digest as named results.' },
    ],
    decisionRules:
      'An account is at risk at a score of 7 or above, on a 1-10 scale. The scorer weighs a renewal inside 90 days, a long gap since last activity, and a rising open-ticket count. Only the top 15 reach the digest.',
    failureHandling:
      'The account pull retries twice and fails the run on a non-2xx response, so a broken credential is loud rather than silently producing an empty scorecard. Per-account scoring collects failures instead of aborting. Posting to Slack continues on error — the scorecard is still returned as a named output.',
    setup: [
      { label: 'Set your CRM API address on the Set the CRM API address step', kind: 'value', ref: 'api-base' },
      { label: 'Set the channel name on the Post to the team channel step', kind: 'value', ref: 'notify' },
      { label: 'Check the Monday 07:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the at-risk cutoff off 7 once you see how your accounts distribute.',
      'Change the top-15 cap in Rank and cap the list.',
      'Add renewal date to the fields kept by Pull open accounts if you want the digest to mention it.',
      'Swap Score churn risk for one of your own agents if you have a scorer with its own tools and memory.',
    ],
    testPlan:
      'Leave the flow as a draft and run it once by hand. Check that Pull open accounts returns accounts, that the score count matches the account count, and that the digest quotes the same number as the filtered list before you switch the schedule on.',
  },
}
