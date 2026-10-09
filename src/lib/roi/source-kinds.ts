/**
 * The extracts an ROI story is built from, and what to call them. Kept apart
 * from ./sources (which reaches the database) so the page's own code — the
 * extract loader — can use the same list.
 */
export const ROI_SOURCE_KINDS = ['activity', 'usage', 'engagement', 'stages', 'clickstream', 'accounts', 'opportunities'] as const
export type RoiSourceKind = (typeof ROI_SOURCE_KINDS)[number]

export const ROI_SOURCE_LABEL: Record<RoiSourceKind, string> = {
  activity: 'Activity extract',
  usage: 'Usage cohort',
  engagement: 'Opportunity engagement',
  stages: 'Closed deals by stage',
  clickstream: 'Account 360 click-stream',
  accounts: 'Parent accounts',
  opportunities: 'Opportunity pull',
}

/**
 * What each extract must carry, in the words the prep uses to recognise it.
 * The prep (src/lib/roi/prep.ts, account360/prep.ts) finds columns by name
 * with fallbacks, so `required` is what a file must have to be read as that
 * extract at all, and `columns` is everything the report can use; a missing
 * optional column empties one metric, never skews another. Every account's
 * extracts follow this one contract, whatever warehouse they come from.
 */
export type RoiExtractContract = {
  /** One line on what the extract is: one row per what. */
  grain: string
  /** Columns the prep must find to treat a file as this extract. */
  required: readonly string[]
  /** Columns the report uses when present (required ones included). */
  columns: readonly string[]
  /** The report sections this extract feeds. */
  feeds: string
  /** How the prep finds plainly named required columns: exactly (has) or as a substring (find_col). */
  match: 'exact' | 'substring'
}

export const ROI_EXTRACT_CONTRACT: Record<RoiSourceKind, RoiExtractContract> = {
  activity: {
    grain: 'One row per rep per month (People.ai activity rollup).',
    required: ['email', 'months', 'meeting_count'],
    columns: [
      'email', 'months', 'meeting_count', 'sent_email_count', 'received_email_count', 'director_meeting_count', 'vp_meeting_count', 'executive_meeting_count',
      'in_person_meeting_count', 'conference_call_count', 'external_people_touched', 'pipeline_created', 'pipeline_created_owned',
      'director_activity_count', 'vp_activity_count', 'executive_activity_count', 'mgmt_activity_count', 'legal_proc_activity_count',
      'finance_activity_count', 'it_activity_count', 'eng_activity_count', 'other_activity_count', 'full_name', 'title', 'role_name', 'team_name', 'team_full_name',
    ],
    feeds: 'Activity trends, leading indicators, cohort comparisons and the roster.',
    match: 'exact',
  },
  usage: {
    grain: 'One row per user (product usage totals over the window).',
    required: ['email'],
    columns: ['email', 'EDB_* or GLASS_* event counts (any numeric usage columns)', 'LAST_USAGE_DATE', 'accounts_viewed', 'opportunities_viewed'],
    feeds: 'Adoption impact: usage tiers and users vs non-users.',
    match: 'substring',
  },
  engagement: {
    grain: 'One row per opportunity (engagement score with the outcome).',
    required: ['an opportunity id (opportunity_crm_id, crm_id or id)', 'an outcome (opportunity_is_won or won)', 'an engagement score (opportunity_engagement_level, avg_engagement or score)'],
    columns: ['opportunity_crm_id', 'opportunity_is_won', 'opportunity_is_closed', 'opportunity_type', 'opportunity_engagement_level', 'opportunity_amount', 'opportunity_name', 'created_at', 'close_date', 'avg_open_to_close', 'account_id'],
    feeds: 'Deal engagement: deciles and levels vs win rate and velocity.',
    match: 'substring',
  },
  stages: {
    grain: 'One row per closed opportunity per stage per activity type.',
    required: ['activity_match_stage', 'opportunity_crm_id', 'opportunity_is_won'],
    columns: ['activity_match_stage', 'opportunity_crm_id', 'opportunity_is_won', 'opportunity_type', 'opportunity_amount', 'activity_type', 'activity_count', 'dir_above_activity_count', 'vp_above_activity_count', 'exec_activity_count', 'title', 'account_name', 'account_crm_id'],
    feeds: 'Stage and persona: where senior engagement lands in won vs lost deals.',
    match: 'exact',
  },
  clickstream: {
    grain: 'One row per Account 360 event (the product click-stream).',
    required: ['a user (email or user)', 'session', 'an event time (time or date)', 'an event type (event_type or type)', 'an account name column (name)'],
    columns: ['user_email', 'session_id', 'event_time', 'event_type', 'account_name', 'page_name'],
    feeds: 'Account engagement: which accounts the team works in Account 360, and how deep.',
    match: 'substring',
  },
  accounts: {
    grain: 'One row per parent account in scope.',
    required: ['an account id column', 'an account name column'],
    columns: ['account_id', 'account_name'],
    feeds: 'Account engagement: the accounts in scope (without it, every account in the opportunity pull is).',
    match: 'substring',
  },
  opportunities: {
    grain: 'One row per opportunity (pipeline created and closed-won by account).',
    required: ['created', 'close_date', 'stage', 'amount'],
    columns: ['opportunity_id', 'account_id', 'parent_account_id', 'account_name', 'created_date', 'close_date', 'stage', 'amount'],
    feeds: 'Account engagement: pipeline created and closed-won per account per month.',
    match: 'substring',
  },
}

/** The extract kinds the standard warehouse pull produces, and the Account 360 set. */
export const ROI_ENGAGEMENT_KINDS: readonly RoiSourceKind[] = ['activity', 'usage', 'engagement', 'stages']
export const ROI_ACCOUNT360_KINDS: readonly RoiSourceKind[] = ['clickstream', 'accounts', 'opportunities']

/**
 * Which of the extract's plainly named required columns a header lacks. A
 * requirement written as a description ("an opportunity id (…)") is checked by
 * any of the names in its parentheses, or by a column containing its key word.
 */
export function missingRequiredColumns(kind: RoiSourceKind, header: readonly string[]): string[] {
  const lower = header.map((name) => name.trim().toLowerCase())
  const contract = ROI_EXTRACT_CONTRACT[kind]
  const present = (name: string) => (contract.match === 'exact' ? lower.includes(name) : lower.some((column) => column.includes(name)))
  return contract.required.filter((requirement) => {
    const names = /\(([^)]+)\)/.exec(requirement)?.[1]?.split(/,|\bor\b/).map((name) => name.trim().toLowerCase()).filter(Boolean)
    // Names in parentheses are matched the way the prep's find_col does: as a substring.
    if (names?.length) return !names.some((name) => lower.some((column) => column.includes(name)))
    if (requirement.startsWith('a ') || requirement.startsWith('an ')) {
      const word = requirement.replace(/^an? /, '').split(/\s+/)[0].toLowerCase()
      return !lower.some((name) => name.includes(word))
    }
    return !present(requirement.toLowerCase())
  })
}
