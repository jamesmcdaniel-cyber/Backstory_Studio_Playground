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
