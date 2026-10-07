import { roiNarrativeSchema, type RoiNarrative } from './contract'
import { summarizeAccount360 } from './account360/facts'
import type { Account360Facts } from './account360/prep'

/**
 * An account whose only finished analysis is an Account 360 page (HP's, for
 * one) still has an ROI report: the standard report drawn from its Account
 * 360 data alone — the Account engagement tab — with findings computed from
 * that data. A full build replaces it once the account's other extracts are
 * analysed.
 */

const money = (value: number) => (value >= 1e6 ? `$${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `$${Math.round(value / 1e3)}K` : `$${Math.round(value)}`)

export function account360Narrative(facts: Account360Facts, account: string, headline?: string | null): RoiNarrative {
  const s = summarizeAccount360(facts)
  const cohort = (name: string) => s.cohorts.find((c) => c.cohort === name)
  const power = cohort('Power Users')
  const none = cohort('No Engagement')
  const total = s.cohorts.reduce((sum, c) => sum + c.totalCreated, 0)
  const ratio = s.ratios.powerVsNoEngagementCreated
  const quiet = s.lowVolumeWithPipeline.length + s.zeroEngagementWithPipeline.length
  const findings: RoiNarrative['findings'] = []
  if (power && none) findings.push({ fig: ratio ? `${ratio}×` : money(power.avgCreated), cap: 'pipeline per account, power users vs none', h: 'Accounts worked in depth carry the pipeline', p: `Power user accounts average **${money(power.avgCreated)}** of pipeline created, against **${money(none.avgCreated)}** for accounts with no Account 360 activity.`, tab: 'accounts' })
  findings.push({ fig: money(total), cap: 'pipeline created, accounts in scope', h: `${s.accounts.engaged} of ${s.accounts.total} parent accounts are engaged`, p: `**${s.accounts.engaged}** of **${s.accounts.total}** parent accounts had Account 360 activity (${s.window.clickStream}); together they created **${money(total)}** of pipeline.`, tab: 'accounts' })
  if (s.ratios.depthLiftFrequentPct !== null) findings.push({ fig: `${s.ratios.depthLiftFrequentPct >= 0 ? '+' : ''}${s.ratios.depthLiftFrequentPct}%`, cap: 'pipeline, depth at the same visit frequency', h: 'Depth beats frequency', p: `At the same visit frequency, accounts worked in depth carry **${s.ratios.depthLiftFrequentPct}%** more created pipeline than accounts that are only browsed.`, tab: 'accounts' })
  if (findings.length < 2) findings.push({ fig: `${s.accounts.total}`, cap: 'parent accounts in scope', h: 'The accounts in scope', p: `Account 360 activity on **${s.accounts.total}** parent accounts.`, tab: 'accounts' })
  const narrative: RoiNarrative = {
    headline: headline && headline.trim().length >= 10 && headline.trim().length <= 100 ? headline.trim() : ratio ? `Accounts worked in depth carry ${ratio}× the pipeline.` : 'Accounts worked in depth carry the pipeline.',
    lede: `How the team uses Account 360 on ${account}'s ${s.accounts.total} parent accounts (${s.window.clickStream}).${power ? ` Power user accounts average **${money(power.avgCreated)}** of pipeline created.` : ''}`,
    findings: findings.slice(0, 6),
    watch: [
      { lead: 'Pipeline with little engagement.', text: quiet ? `${quiet} accounts carry pipeline with few or no Account 360 sessions — where engagement is the gap.` : 'Every account carrying pipeline has Account 360 activity.' },
      { lead: 'These are correlations.', text: 'Teams spend more time on accounts that are already moving.' },
    ],
    notes: {},
    caveats: ['Built from the Account 360 extracts alone: the activity, adoption, deal and stage views need the activity, usage and deal extracts.'],
  }
  return roiNarrativeSchema.parse(narrative)
}
