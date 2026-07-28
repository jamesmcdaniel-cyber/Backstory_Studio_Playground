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

/**
 * The built-in flow catalogue every workspace sees, served after the org's own
 * and the community's stored templates (mirroring `builtInTemplates` in
 * src/lib/templates/builtin-agents.ts).
 *
 * Ordered real-work-first. The Flows page offers only the first handful inline,
 * and a catalogue that opens with "Summarize & extract" reads like an engine
 * demo — so the revenue pipelines that call Backstory and delegate to an agent
 * lead, the engine showcases follow, and the connection-free starters sit after
 * them for anyone who wants a zero-setup first run.
 */
export const BUILTIN_FLOW_TEMPLATES: FlowTemplateDef[] = [
  PIPELINE_DIGEST,
  UPSELL_MOTION,
  ACCOUNT_PLAN,
  CHURN_RISK_SCORECARD,
  RENEWAL_BRIEF,
  WEBHOOK_TRIAGE,
  SUMMARIZE_EXTRACT,
  SCORE_EACH_ITEM,
  SCHEDULED_WAIT,
  CSV_ENRICHMENT,
  NIGHTLY_SYNC,
]

export function findBuiltinFlowTemplate(id: string): FlowTemplateDef | undefined {
  return BUILTIN_FLOW_TEMPLATES.find((template) => template.id === id)
}
