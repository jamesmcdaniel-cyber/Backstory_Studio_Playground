/**
 * A role label derived locally from what an agent is told to do.
 *
 * The AI label is better, but it needs a model call that can be slow,
 * rate-limited, or unavailable to the web runtime entirely — and a card whose
 * descriptor never arrives is the thing this exists to prevent. This runs
 * instantly with no network, so a card always says what it does; the AI label
 * replaces it when (and only when) one comes back.
 *
 * Deliberately confidence-gated: a wrong job title is worse than none, so an
 * agent whose text matches nothing gets null and simply shows no chip.
 */

/**
 * Verb/keyword → role, most specific first. Matching stops at the first hit, so
 * "summarize the pipeline" reads as a Summarizer rather than a Pipeline Watcher.
 */
const ROLES: Array<{ role: string; patterns: RegExp }> = [
  { role: 'Meeting Scribe', patterns: /\b(meeting|call) (note|notes|recap|summar)|\bscribe\b|\btranscri/i },
  { role: 'Deal Researcher', patterns: /\bresearch\w*\b.*\b(account|deal|opportunit|prospect|compan)|\b(account|deal|prospect) research/i },
  { role: 'Pipeline Reporter', patterns: /\bpipeline\b|\bforecast\w*\b|\bquota\b/i },
  { role: 'Renewal Watcher', patterns: /\brenewal|\bchurn\b|\bexpir\w+ (contract|subscription)/i },
  { role: 'Upsell Scout', patterns: /\bupsell|\bcross-?sell|\bexpansion (opportunit|revenue)/i },
  { role: 'Lead Qualifier', patterns: /\bqualif\w+\b|\blead scoring\b|\binbound lead/i },
  { role: 'Outreach Writer', patterns: /\b(draft|write|compose|send)\b.*\b(email|message|outreach|sequence|follow-?up)|\bcold (email|outreach)/i },
  { role: 'Digest Builder', patterns: /\bdigest\b|\bnewsletter\b|\broundup\b|\bweekly (summary|update)/i },
  { role: 'Status Reporter', patterns: /\b(status|progress|standup) (report|update)|\breport\w*\b.*\bweekly\b/i },
  { role: 'News Watcher', patterns: /\bnews\b|\bpress release|\bannouncement/i },
  { role: 'Data Syncer', patterns: /\bsync\w*\b|\bimport\w*\b|\bmigrat\w+\b.*\brecord/i },
  { role: 'CRM Updater', patterns: /\b(update|enrich|clean)\w*\b.*\b(crm|salesforce|record|field)/i },
  { role: 'Ticket Triager', patterns: /\btriage\b|\bticket|\bissue queue|\bbug report/i },
  { role: 'Code Reviewer', patterns: /\bcode review|\bpull request|\bpr review|\bdiff\b/i },
  { role: 'Support Responder', patterns: /\bsupport\b|\bcustomer (question|inquiry|request)/i },
  { role: 'Content Writer', patterns: /\bblog\b|\bcopywrit|\barticle\b|\bcontent\b.*\bwrite/i },
  { role: 'Competitor Analyst', patterns: /\bcompetitor|\bcompetitive (intel|landscape)/i },
  { role: 'Summarizer', patterns: /\bsummar/i },
  { role: 'Researcher', patterns: /\bresearch/i },
  { role: 'Reporter', patterns: /\breport/i },
  { role: 'Monitor', patterns: /\bmonitor\w*\b|\bwatch\w*\b|\balert\w*\b/i },
  { role: 'Analyst', patterns: /\banaly[sz]/i },
  { role: 'Scheduler', patterns: /\bschedul\w+\b|\bcalendar\b|\bbook\w*\b.*\bmeeting/i },
]

/**
 * Best-effort role for one agent. `text` should be the agent's instructions and
 * title together — instructions describe the job, the title often does not.
 */
export function deriveRoleLabel(...parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join(' \n ')
  if (!text.trim()) return null
  for (const { role, patterns } of ROLES) {
    if (patterns.test(text)) return role
  }
  return null
}

/**
 * The role covering a group of agents: the one they share, or null when the
 * roster is too mixed to honestly summarise without a model.
 */
export function deriveGroupRoleLabel(perAgent: Array<string | null>): string | null {
  const found = perAgent.filter((role): role is string => Boolean(role))
  if (!found.length) return null
  const unique = [...new Set(found)]
  return unique.length === 1 ? unique[0] : null
}
