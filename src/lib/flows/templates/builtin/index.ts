import type { FlowTemplateDef } from '@/lib/flows/templates/types'
import { SUMMARIZE_EXTRACT, SCORE_EACH_ITEM, SCHEDULED_WAIT } from '@/lib/flows/templates/builtin/starters'
import { CHURN_RISK_SCORECARD } from '@/lib/flows/templates/builtin/churn-risk-scorecard'
import { RENEWAL_BRIEF } from '@/lib/flows/templates/builtin/renewal-brief'
import { WEBHOOK_TRIAGE } from '@/lib/flows/templates/builtin/webhook-triage'
import { CSV_ENRICHMENT } from '@/lib/flows/templates/builtin/csv-enrichment'
import { NIGHTLY_SYNC } from '@/lib/flows/templates/builtin/nightly-sync'
import { UPSELL_MOTION } from '@/lib/flows/templates/builtin/upsell-motion'
import { ACCOUNT_PLAN } from '@/lib/flows/templates/builtin/account-plan'
import { PIPELINE_DIGEST } from '@/lib/flows/templates/builtin/pipeline-digest'
import { GITHUB_STANDUP_DIGEST, GITHUB_STALE_PR_NUDGE, BUG_INTAKE_TO_LINEAR, FIGMA_REVIEW_DIGEST } from '@/lib/flows/templates/builtin/dev-collab'
import { ZENDESK_TICKET_PULSE, SUPPORT_THEME_REPORT, CUSTOMER_CHANNEL_MONITOR, CSAT_DETRACTOR_FOLLOWUP } from '@/lib/flows/templates/builtin/support-ops'
import { HUBSPOT_LEAD_ROUTER, SALESFORCE_HYGIENE_AUDIT, INBOX_TRIAGE_BRIEF, ACCOUNT_HANDOFF_BRIEF } from '@/lib/flows/templates/builtin/revenue-ops'
import { SHEET_ANOMALY_WATCH, DRIVE_FRESH_DOCS_DIGEST, AIRTABLE_REVIEW_QUEUE, NOTES_TO_NOTION } from '@/lib/flows/templates/builtin/workspace-data'
import { JIRA_SPRINT_HEALTH, MONDAY_BOARD_SNAPSHOT, ONBOARDING_KICKOFF, WEEKLY_EXEC_BRIEF } from '@/lib/flows/templates/builtin/team-cadence'

/**
 * The built-in flow catalogue every workspace sees, served after the org's own
 * and the community's stored templates (mirroring `builtInTemplates` in
 * src/lib/templates/builtin-agents.ts).
 *
 * Ordered real-work-first. The Flows page offers only the first handful inline,
 * and a catalogue that opens with "Summarize & extract" reads like an engine
 * demo — so the revenue pipelines that call Backstory and delegate to an agent
 * lead, the wider integration catalogue (support, engineering, docs, cadence)
 * follows, and the connection-free starters sit after them for anyone who
 * wants a zero-setup first run.
 */
export const BUILTIN_FLOW_TEMPLATES: FlowTemplateDef[] = [
  PIPELINE_DIGEST,
  UPSELL_MOTION,
  ACCOUNT_PLAN,
  CHURN_RISK_SCORECARD,
  RENEWAL_BRIEF,
  WEBHOOK_TRIAGE,
  // Revenue operations beyond the opening Backstory/Slack pair.
  HUBSPOT_LEAD_ROUTER,
  SALESFORCE_HYGIENE_AUDIT,
  ACCOUNT_HANDOFF_BRIEF,
  INBOX_TRIAGE_BRIEF,
  WEEKLY_EXEC_BRIEF,
  // Support operations.
  ZENDESK_TICKET_PULSE,
  CSAT_DETRACTOR_FOLLOWUP,
  CUSTOMER_CHANNEL_MONITOR,
  SUPPORT_THEME_REPORT,
  // Engineering & design.
  GITHUB_STANDUP_DIGEST,
  GITHUB_STALE_PR_NUDGE,
  BUG_INTAKE_TO_LINEAR,
  FIGMA_REVIEW_DIGEST,
  JIRA_SPRINT_HEALTH,
  // Docs & data.
  SHEET_ANOMALY_WATCH,
  AIRTABLE_REVIEW_QUEUE,
  DRIVE_FRESH_DOCS_DIGEST,
  NOTES_TO_NOTION,
  // Team cadence.
  ONBOARDING_KICKOFF,
  MONDAY_BOARD_SNAPSHOT,
  // Engine showcases and zero-setup starters.
  SUMMARIZE_EXTRACT,
  SCORE_EACH_ITEM,
  SCHEDULED_WAIT,
  CSV_ENRICHMENT,
  NIGHTLY_SYNC,
]

export function findBuiltinFlowTemplate(id: string): FlowTemplateDef | undefined {
  return BUILTIN_FLOW_TEMPLATES.find((template) => template.id === id)
}
