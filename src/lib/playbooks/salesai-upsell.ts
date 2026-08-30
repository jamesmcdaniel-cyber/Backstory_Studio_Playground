import type { FlowGraph } from '@/lib/flows/graph'

/**
 * The SalesAI Upsell Engine playbook (from the BRD): a deterministic Flow that
 * covers the full solution architecture —
 *   Data sources: Backstory MCP (primary), CRM (Salesforce), usage data
 *   (Snowflake), Query API (http tool)
 *   AI processing: readiness score, competitive risk, use-case alignment,
 *   sales-motion planning (all four in the scorer's contract)
 *   Outputs: Priority Matrix, Stakeholder List, Action Plans, Executive Digest
 *   (four parallel builders), assembled and posted to Slack by a publisher.
 * One-click provisioned: agents are created (idempotently) and the flow graph
 * is wired to their ids.
 */

export const PLAYBOOK_FLOW_NAME = 'SalesAI Upsell Engine'

export const PLAYBOOK_AGENTS = {
  puller: {
    title: 'Upsell Candidate Puller',
    description: 'Lists in-segment accounts for the SalesAI upsell motion as strict JSON.',
    integrations: ['Backstory MCP', 'nango:salesforce', 'HTTP API'],
    instructions: [
      'You list candidate accounts for a SalesAI upsell motion. The input names the target segment; when empty, default to accounts that own Data Foundation + EDB but NOT SalesAI (the low-hanging fruit). "ClosePlan-only" means customers whose only product is ClosePlan (e.g. Seismic, CRWD, ZS, PANW).',
      'Use the Backstory Sales AI tools to pull the account list for the segment. Cross-check product ownership against the CRM via your Salesforce tools when available. If Snowflake is available through your tools, enrich with product-usage/feature-adoption signals to pre-filter obviously inactive accounts. The http request tool is available for any additional REST API the user points you at.',
      'OUTPUT CONTRACT: respond with ONLY a JSON array of account-name strings — no prose, no markdown fence, max 25 entries, most promising first. Example: ["Seismic","Zscaler","CrowdStrike"]. If you cannot retrieve any accounts, return [] and nothing else.',
    ].join('\n'),
  },
  scorer: {
    title: 'Upsell Account Scorer',
    description: 'Scores one account across readiness, competitive risk, use-case fit, and sales motion — strict JSON.',
    integrations: ['Backstory MCP', 'nango:salesforce', 'HTTP API'],
    instructions: [
      'You analyze ONE account (given as input) for SalesAI expansion across ALL FOUR dimensions of the upsell engine: adoption readiness, competitive risk, use-case alignment, and sales-motion planning.',
      'Sources: Backstory Sales AI (engagement, stakeholders, activity), Salesforce CRM (opportunities, win/loss history, account owner), Snowflake (product usage / feature adoption) — plus the http request tool for any extra API the user names. Use what is available; never fabricate what is not.',
      'OUTPUT CONTRACT: respond with ONLY a JSON object — no prose, no markdown fence — shaped exactly:',
      '{"account": string, "score": number (0-100), "subscores": {"dataQuality": number, "featureAdoption": number, "engagement": number, "arrHealth": number}, "competitiveRisk": {"level": "low"|"medium"|"high", "threats": string[], "churnSignals": string[]}, "useCaseAlignment": {"primary": string, "rationale": string, "additional": string[]}, "salesMotion": {"decisionMakers": string[], "entryPoint": string, "timelineWeeks": number, "firstMeetingGoal": string}, "dataGaps": string[]}',
      'Scoring discipline: when a dimension is unknowable from your tools, score it conservatively and record why in dataGaps (e.g. "no usage data available"). decisionMakers must be real named contacts from Backstory/CRM, never invented.',
    ].join('\n'),
  },
  composer: {
    title: 'Upsell Output Composer',
    description: 'Builds one named deliverable (matrix, stakeholders, action plans, or digest) from the scorecards.',
    integrations: ['HTTP API'],
    instructions: [
      'You build ONE named deliverable from a set of account scorecards (JSON array with fields: account, score, subscores, competitiveRisk, useCaseAlignment, salesMotion, dataGaps). The input names which deliverable to produce, then provides the scorecards. Produce clean Markdown for exactly that deliverable — nothing else.',
      'PRIORITY MATRIX: tier every scored account into NOW / NEXT / NURTURE / MONITOR by readiness score crossed with competitive-risk level (high risk pulls a ready account into NOW — expansion defends the account). One table per tier: account, score, risk level, primary use case, one-line rationale.',
      'STAKEHOLDER LIST: for the top accounts, the named decision-makers with role/relationship context from the scorecards, the entry point, and who should engage them. Group by account; flag accounts with no known stakeholders as a gap.',
      'ACTION PLANS: for the top 5 accounts, a concrete 4-week deployment roadmap — week-by-week actions, the entry use case, first-meeting goal, and the success metric that proves readiness for the SalesAI conversation.',
      'EXECUTIVE DIGEST: at most 300 words for sales leadership — segment health in one paragraph, the top 5 opportunities with scores, aggregate risk themes, and a single recommended focus for the coming week. Lead with the numbers (accounts scored, ready-now count, average score).',
      'Always state counts precisely and carry the scorecards\' dataGaps through honestly. Use only what the scorecards contain — never invent accounts, people, or numbers.',
    ].join('\n'),
  },
  publisher: {
    title: 'Upsell Digest Publisher',
    description: 'Assembles the four deliverables and posts them to Slack.',
    integrations: ['nango:slack', 'HTTP API'],
    instructions: [
      'You receive a JSON object with four Markdown deliverables: matrix (Priority Matrix), stakeholders (Stakeholder List), actions (Action Plans), digest (Executive Digest).',
      'Post to Slack using your Slack tools — default channel #sales-ai-upsell unless the input names another: send the Executive Digest as the main message, then the Priority Matrix, Stakeholder List, and Action Plans as follow-up messages (thread replies when supported).',
      'If posting fails, do not retry more than once; instead return the full assembled report. Either way, your final answer is the complete report: digest first, then matrix, stakeholders, and action plans, under clear ## headings.',
    ].join('\n'),
  },
} as const

/** Wire the playbook flow graph to the provisioned agent ids. */
export function buildUpsellGraph(agentIds: { puller: string; scorer: string; composer: string; publisher: string }): FlowGraph {
  const composerBranch = (id: string, deliverable: string, label: string) =>
    ({
      id,
      type: 'agent',
      data: {
        agentId: agentIds.composer,
        label,
        input: `Produce the ${deliverable}.\n\nScorecards: {{step.score_each.output}}`,
        onError: 'continue',
      },
    }) as const

  return {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual', input: 'Data Foundation + EDB only' } } },
      {
        id: 'pull',
        type: 'agent',
        data: {
          agentId: agentIds.puller,
          label: 'Pull in-segment accounts',
          input: 'Segment: {{trigger.input}}',
          retries: 1,
        },
      },
      {
        id: 'score_each',
        type: 'loop',
        data: { label: 'Score each account (4-dimension analysis)', over: '{{step.pull.output}}', concurrency: 5, body: ['score'] },
      },
      {
        id: 'score',
        type: 'agent',
        data: {
          agentId: agentIds.scorer,
          label: 'Readiness · risk · use case · motion',
          input: '{{item}}',
          onError: 'continue',
          outputFields: [
            { name: 'account', type: 'string' },
            { name: 'score', type: 'number' },
            { name: 'competitiveRisk', type: 'object' },
            { name: 'useCaseAlignment', type: 'object' },
            { name: 'salesMotion', type: 'object' },
            { name: 'dataGaps', type: 'array' },
          ],
        },
      },
      {
        id: 'outputs',
        type: 'parallel',
        data: {
          label: 'Build the four deliverables',
          branches: [['matrix'], ['stakeholders'], ['actions'], ['digest']],
        },
      },
      composerBranch('matrix', 'PRIORITY MATRIX', 'Priority Matrix'),
      composerBranch('stakeholders', 'STAKEHOLDER LIST', 'Stakeholder List'),
      composerBranch('actions', 'ACTION PLANS', 'Action Plans'),
      composerBranch('digest', 'EXECUTIVE DIGEST', 'Executive Digest'),
      {
        id: 'publish',
        type: 'agent',
        data: {
          agentId: agentIds.publisher,
          label: 'Assemble + post to Slack',
          input: 'Deliverables: {{step.outputs.output}}',
          retries: 1,
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'score_each' },
      { id: 'e2', source: 'score_each', target: 'outputs' },
      { id: 'e3', source: 'outputs', target: 'publish' },
    ],
  }
}
