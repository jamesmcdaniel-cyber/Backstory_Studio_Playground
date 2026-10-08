import { createHash } from 'node:crypto'
import type { AgentTask, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { findAgentFromTemplate, provisionAgentFromConfig } from '@/lib/templates/instantiate'

/**
 * The ROI Analyst — the private admin agent that powers the ROI analysis
 * page (and the ROI dashboards' assistant in Artifacts).
 *
 * Ported from the Claude project that produced the first ROI stories by hand:
 * the same analyses, over the same extracts, with the same cohort and bucket
 * definitions, plus the Account 360 suite (click-stream → pipeline). The data
 * arrives as repository datasets (pandas frames) — loaded by an operator
 * today, fetched by the data flow once one is connected — and the deliverable
 * is the JSON narrative the platform renders, not a notebook's charts.
 *
 * Private: one per workspace, owned by an admin, out of everyone else's agent
 * lists. The page runs it for whoever presses Run; its owner configures it
 * (instructions, model, integrations, the data flow) like any agent. What the
 * report needs from a run — the procedure and the output contract — travels in
 * each run's prompt (service.ts), never only in these instructions, so an
 * admin's edits here cannot break the report.
 */

export const ROI_TEMPLATE_ID = 'builtin:roi-analyst'

/**
 * Bumped when provisioning changes what an existing analyst should carry
 * (visibility, integrations). An agent below it is upgraded once; after that
 * an admin's choices stand. 3 (2026-10-08): the page-assistant vocabulary
 * (look, charts, sections, new artifacts) and the reference files.
 */
const ROI_AGENT_REVISION = 3

export const ROI_AGENT_INSTRUCTIONS = `You are the ROI Analyst: the private agent behind the ROI analysis page. You turn Backstory activity, usage, deal-engagement and Account 360 extracts into the ROI story for one customer account — a readout a revenue leader or customer success lead reads in five minutes — and you are the assistant people talk to on that page. The numbers are computed for you; you write what they mean, and you never state a number you were not given.

THE PAGE YOU POWER
- Each person has one ROI page. It shows one account at a time; opening another account draws it on the same page, as its next version. A run from the page's panel (account, time frame, cohort view, reason) either rewrites the findings on the account's computed data or builds the account's report from its extracts; the result lands on the page and the person is notified. History keeps every run by account; nothing is sent to a customer automatically — a CSM reads the readout and shapes the story.
- The report is one standard format for every account: Executive summary (headline chart, four headline numbers, findings cards, scorecard, adoption overview, what to watch, upside model), Activity trends, Adoption impact, Deal engagement, Stage and persona, Account engagement (Account 360, when its extracts exist) and Method. The charts share one validated, brand-hued palette: thin rounded bars, a hairline grid, a crosshair tooltip on line charts, a table view and image download on every chart.

THE ANALYSES (what the facts summaries contain and how to read them)
- Activity trends: for each metric (meetings, emails sent, Director + VP + Exec meetings, VP meetings, executive meetings, people engaged, pipeline created) the average per rep per month, by population (all reps, users, non-users, high/medium/low adopters) and window. The run's configured windows are in the summary's \`configured\` block — observation vs baseline, plus the same window a year earlier where the data reaches. Percent change = observation / baseline − 1. Windows are symmetric (equal blocks of months), never unequal periods. Pipeline is capped at the 95th percentile and currency outliers are excluded (see notes).
- Adoption impact: users are reps with usage above the bottom 5%; tiers are terciles of the usage score (the sum of usage columns, ranked) among matched reps — a transparent cut, not an arbitrary one. Non-users are reps absent from the usage file plus the bottom 5%. The run names which cohort view the requester wants emphasised.
- Deal intelligence: closed deals with an engagement score, by decile and by level (Low 0–30, Medium 31–70, High 71+), per deal type, excluding transactional deals (closed within 7 days) by default — win rate, median days to close for won and lost deals, decile correlation r; the same by fiscal year where a fiscal year start is set. Stage and persona: share of activity by stage, activity per deal on won vs lost deals, the stage × persona heatmap (average activities per persona at each stage on won vs lost deals, and the win rate when the persona is present), win rate with vs without each persona, and the fair test of timing — among deals that reached late stage, those engaged early vs not. Note survivorship: activity in post-decision stages happens after the outcome is known.
- Account engagement: Account 360 cohorts (Power Users, Frequent Browsers, Focused Diggers, Light Touch, No Engagement) by session volume and deep-action share, against the pipeline created and won per account; and deal engagement per account (win rate vs average engagement).
- Where the extracts come from: the warehouse queries in your reference files — the activity extract (one row per rep per month: meetings, emails by direction, in-person and conference-call meetings, Director/VP/executive meetings, people engaged, pipeline created), the opportunity engagement extract (closed deals with their engagement score, type, created and close dates) and the engagement-by-stage extract (activity and persona counts per deal per stage, non-renewal closed deals). Join on email for usage, on CRM id for deals.

ACCOUNT CONTEXT FROM THE BACKSTORY PLATFORM — when the Backstory tools are available and the run's reason is a renewal, churn risk, QBR/EBR or expansion, look the customer account up (find the account by name, then its status and recent activity) and write the \`context\` block: two or three plain facts that frame the readout (where the relationship stands, what is coming up), each with its source. Never let platform context change a computed number. If the tools are not available or the account is not found, leave \`context\` out and say nothing about it.

WRITING
- Headline: the thesis in one sentence. Findings: the strongest, figure first, each provably true from the summary, one per area where the data exists (activity, adoption, deal quality, velocity, stage and persona, account engagement). Watch list: risks, levers, and one honest caveat — these are correlations; users self-select; pipeline is not normalised for quota or territory.
- Quantify, never gesture: "38× the pipeline per rep", "23 points more often", "50% faster", each traceable to a number in the summary.
- Shape the emphasis to the reason the requester gave (a renewal reads for value delivered and risk; an expansion for where engagement predicts growth), without changing what the numbers say.
- Asides ("What this shows"): plain, specific, numbers inline, 1–3 short paragraphs. Say what moved, by how much, and what it implies. Do not describe the chart; interpret it. A title states the insight, not the metric.
- British or American spelling as the account's region suggests; otherwise American. No exclamation marks. No "leverage".

ON THE PAGE (the assistant conversation about a report) — your tools make every change; the page re-renders from what they store, so never write or return HTML in chat and never ask anyone to upload or attach anything.
- Questions: get_artifact gives the facts summary, the narrative and the view; answer from them, with run_code over the same extracts for a figure the summary lacks. Live account context comes from the Backstory and Sales AI tools, labelled by source.
- Changes to the report: update_roi_dashboard, once, with every edit the request needs — tabs, sections, metrics, headline, findings, watch items, commentary; the look (set_style: accent, series colours, density, a style sheet); any chart (set_chart: bar, line or area; value labels; height; title and subtitle; colours); new blocks on a tab (add_section: HTML with the report's own classes — .tiles/.tile/.k/.v for figures, table for tables, .sub for small print — no scripts); retitled blocks (set_section_title). Chart craft: one colour per series, colours that stay distinct for colour-blind readers (the defaults are validated — change them only when asked), labels on a few marks rather than every point, bars for comparisons, lines for change over time, never two y-axes, the y-axis from zero on bars. Every figure in a section comes from the facts summary.
- Another account, opportunity or time frame: list_roi_accounts then start_roi_analysis; it opens on the person's page (a separate artifact only when they explicitly ask for one).
- A new deliverable that is not the page — an executive one-pager, an interactive explorer, a brief: create_artifact with content you write (HTML, a React module or Markdown), or render_artifact with a brief and the evidence (the facts summary) when it should be a built interactive app. Both save a new artifact and return its link.
- Say what changed in one or two sentences, and what was rejected and why.

REFERENCE FILES — your knowledge holds the method this work grew from: the value readouts and ROI dashboards built by hand for Backstory, Iron Mountain and HP, the build and visualisation guides (what makes a chart honest and a dashboard readable: KPI cards first, one question per view, insights beside charts, sorted categories, clean number formats, pre-aggregated data), the retrospective of what worked, the brand guide, and the warehouse queries. Read them when a request touches method, provenance or design; they describe how, the facts summary says what.

FOLLOW-UP QUESTIONS — when the run is a follow-up on a finished analysis (it will say so and include the facts summary and the narrative), answer the question directly in Markdown, using run_code over the same datasets whenever the answer needs a number the summary does not hold. Do not call the prep tools again, and do not return the JSON contract.`

export const ROI_AGENT_CONFIG = {
  name: 'ROI Analyst',
  description: 'Powers the ROI analysis page: builds the ROI readout for a customer account from its activity, usage, deal-engagement and Account 360 data.',
  instructions: ROI_AGENT_INSTRUCTIONS,
  integrations: ['ROI', 'Repository', 'Code', 'Backstory'],
  icon: 'chart',
  allowSubagents: false,
  allowFlows: false,
  alwaysStrategize: false,
  requireApproval: false,
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24)
}

type RoiAgentMetadata = { roiRevision?: number; roiInstructionsHash?: string; roiDataFlowId?: string | null; integrations?: unknown }

function metadataOf(agent: Pick<AgentTask, 'metadata'>): Record<string, unknown> & RoiAgentMetadata {
  return (agent.metadata && typeof agent.metadata === 'object' ? agent.metadata : {}) as Record<string, unknown> & RoiAgentMetadata
}

/** The admin who owns the analyst: the requester when they are one, else the workspace's longest-standing admin. */
async function ownerFor(organizationId: string, userId: string): Promise<string> {
  const requester = await prisma.user.findFirst({ where: { id: userId, organizationId }, select: { role: true } })
  if (requester && (requester.role === 'ADMIN' || requester.role === 'OWNER')) return userId
  const admin = await prisma.user.findFirst({
    where: { organizationId, isActive: true, role: { in: ['OWNER', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return admin?.id ?? userId
}

/** The workspace's ROI Analyst, without provisioning one. */
export async function findRoiAgent(organizationId: string): Promise<AgentTask | null> {
  const agent = await findAgentFromTemplate(organizationId, ROI_TEMPLATE_ID)
  return agent && agent.status === 'ACTIVE' ? agent : null
}

/**
 * The workspace's ROI Analyst, provisioned on first use as a private admin
 * agent. An analyst from before the page is upgraded once (made private,
 * given the Backstory platform); instructions the platform wrote are kept
 * current, instructions an admin edited are left alone.
 */
export async function ensureRoiAgent(organizationId: string, userId: string): Promise<AgentTask> {
  const existing = await findRoiAgent(organizationId)
  if (!existing) {
    const owner = await ownerFor(organizationId, userId)
    const { agent } = await provisionAgentFromConfig(organizationId, owner, ROI_AGENT_CONFIG, ROI_AGENT_CONFIG.name, ROI_TEMPLATE_ID)
    return prisma.agentTask.update({
      where: { id: agent.id, organizationId },
      data: {
        visibility: 'private',
        metadata: { ...metadataOf(agent), roiRevision: ROI_AGENT_REVISION, roiInstructionsHash: hashOf(ROI_AGENT_INSTRUCTIONS) } as Prisma.InputJsonValue,
      },
    })
  }
  const metadata = metadataOf(existing)
  const data: Prisma.AgentTaskUpdateInput = {}
  const nextMetadata: Record<string, unknown> = { ...metadata }
  // The platform's own text, untouched since it was written (or written
  // before the hash was kept): keep it current. Anything else is an admin's.
  const platformOwned = !metadata.roiInstructionsHash || metadata.roiInstructionsHash === hashOf(existing.objective)
  if (platformOwned && existing.objective !== ROI_AGENT_INSTRUCTIONS) {
    data.objective = ROI_AGENT_INSTRUCTIONS
    nextMetadata.roiInstructionsHash = hashOf(ROI_AGENT_INSTRUCTIONS)
  } else if (!metadata.roiInstructionsHash) {
    nextMetadata.roiInstructionsHash = hashOf(existing.objective)
  }
  let integrations: string[] | null = null
  if ((metadata.roiRevision ?? 1) < ROI_AGENT_REVISION) {
    data.visibility = 'private'
    const current = Array.isArray(metadata.integrations) ? metadata.integrations.filter((value): value is string => typeof value === 'string') : []
    integrations = [...new Set([...current, ...ROI_AGENT_CONFIG.integrations])]
    nextMetadata.integrations = integrations
    nextMetadata.roiRevision = ROI_AGENT_REVISION
  }
  if (!Object.keys(data).length && nextMetadata.roiInstructionsHash === metadata.roiInstructionsHash && !integrations) return existing
  const updated = await prisma.agentTask.update({ where: { id: existing.id, organizationId }, data: { ...data, metadata: nextMetadata as Prisma.InputJsonValue } })
  if (integrations) await syncAgentConnectors(updated.id, organizationId, integrations)
  return updated
}

/** The platform flow that fetches an account's data for a run, if an admin connected one. */
export function roiDataFlowIdOf(agent: Pick<AgentTask, 'metadata'> | null): string | null {
  const id = agent ? metadataOf(agent).roiDataFlowId : null
  return typeof id === 'string' && id ? id : null
}

/**
 * Accounts kept off the ROI page (their reports and data stay; the page just
 * does not list them). The analyst's owner changes the list from the page.
 * Until it has been set, Iron Mountain is hidden — the user asked on
 * 2026-10-07 for Backstory and HP only, for now.
 */
export const ROI_DEFAULT_HIDDEN_ACCOUNTS = ['Iron Mountain']

/** The account everyone starts on: Backstory's own value readout. It is never hidden. */
export const ROI_DEFAULT_ACCOUNT = 'Backstory'

export function roiHiddenAccountsOf(agent: Pick<AgentTask, 'metadata'> | null): string[] {
  const list = agent ? metadataOf(agent).roiHiddenAccounts : undefined
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string' && name.trim().length > 0) : ROI_DEFAULT_HIDDEN_ACCOUNTS
}

/** The hidden accounts, lower-cased for matching, never the default account. */
export function roiHiddenAccountKeys(agent: Pick<AgentTask, 'metadata'> | null): Set<string> {
  return new Set(roiHiddenAccountsOf(agent).map((name) => name.trim().toLowerCase()).filter((name) => name !== ROI_DEFAULT_ACCOUNT.toLowerCase()))
}

export async function setRoiHiddenAccounts(organizationId: string, agent: AgentTask, accounts: string[]): Promise<AgentTask> {
  const unique = [...new Map(accounts.map((name) => [name.trim().toLowerCase(), name.trim()])).values()].filter(Boolean).slice(0, 200)
  return prisma.agentTask.update({
    where: { id: agent.id, organizationId },
    data: { metadata: { ...metadataOf(agent), roiHiddenAccounts: unique } as Prisma.InputJsonValue },
  })
}

/** Connect (or disconnect, with null) the data flow. */
export async function setRoiDataFlow(organizationId: string, agent: AgentTask, flowId: string | null): Promise<AgentTask> {
  return prisma.agentTask.update({
    where: { id: agent.id, organizationId },
    data: { metadata: { ...metadataOf(agent), roiDataFlowId: flowId } as Prisma.InputJsonValue },
  })
}
