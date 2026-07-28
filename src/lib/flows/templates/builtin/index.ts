import type { FlowTemplateDef } from '@/lib/flows/templates/types'
import { SUMMARIZE_EXTRACT, SCORE_EACH_ITEM, SCHEDULED_WAIT } from '@/lib/flows/templates/builtin/starters'
import { CHURN_RISK_SCORECARD } from '@/lib/flows/templates/builtin/churn-risk-scorecard'
import { RENEWAL_BRIEF } from '@/lib/flows/templates/builtin/renewal-brief'
import { WEBHOOK_TRIAGE } from '@/lib/flows/templates/builtin/webhook-triage'
import { CSV_ENRICHMENT } from '@/lib/flows/templates/builtin/csv-enrichment'
import { NIGHTLY_SYNC } from '@/lib/flows/templates/builtin/nightly-sync'

/**
 * The built-in flow catalogue every workspace sees, served after the org's own
 * and the community's stored templates (mirroring `builtInTemplates` in the
 * agent-templates route). Ordered starters-first: the three connection-free
 * flows instantiate ready to run, so they stay the fastest first success.
 */
export const BUILTIN_FLOW_TEMPLATES: FlowTemplateDef[] = [
  SUMMARIZE_EXTRACT,
  SCORE_EACH_ITEM,
  SCHEDULED_WAIT,
  CHURN_RISK_SCORECARD,
  RENEWAL_BRIEF,
  WEBHOOK_TRIAGE,
  CSV_ENRICHMENT,
  NIGHTLY_SYNC,
]

export function findBuiltinFlowTemplate(id: string): FlowTemplateDef | undefined {
  return BUILTIN_FLOW_TEMPLATES.find((template) => template.id === id)
}
