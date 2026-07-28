import { actionPlan, dim, high, med, num } from './report-builder'
import type { ReportSpec } from './report-builder'

/** Coaching, enablement, competitive, and account-channel templates (10–18). */
export const COACHING_SPECS: Record<string, ReportSpec> = {
  '10-activity-gap-detector': {
    eyebrow: 'Coaching intelligence report',
    title: 'Activity gaps — week of Jul 13',
    sub: 'Compared each rep’s weekly activity against team benchmarks and the top-performer profile.',
    pill: '1 rep below threshold · 6 on track',
    stats: [
      ['📉', '40%', 'Below median (Rep C)'],
      ['🤝', '1.2', 'Avg contacts per deal (Rep C)'],
      ['🏅', '3.4', 'Team benchmark'],
      ['📅', '0', 'Exec meetings booked'],
    ],
    summary:
      'Six of seven reps are inside the normal activity band. Rep C is the outlier on every measure that predicts a slipped quarter: 40% fewer outbound touches than the team median, no executive meetings booked, and open deals averaging 1.2 contacts against a team benchmark of 3.4. Multi-threading is the single coaching lever — Rep A, the top performer, runs five multi-threaded accounts on the same territory size.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Activity versus benchmark',
        count: '7 reps compared',
        head: ['Flag', 'Rep', num('Touches'), num('Contacts / deal'), num('Exec meetings'), 'Read'],
        rows: [
          [high('Coach'), 'Rep C', num('13'), num('1.2'), num('0'), 'Single-threaded across the whole book'],
          [med('Watch'), 'Rep F', num('18'), num('2.6'), num('1'), 'Slipping on exec coverage'],
          [dim('Benchmark'), 'Rep A (top)', num('22'), num('3.9'), num('5'), '5 multi-threaded accounts'],
          [dim('Team median'), '—', num('21'), num('3.4'), num('3'), 'Normal band'],
        ],
      },
      actionPlan([
        ['Run a multi-threading exercise on Rep C’s three largest deals', 'Manager', 'Jul 17'],
        ['Set a floor of 2 executive meetings per week for Rep C', 'Manager', 'Jul 18'],
        ['Pair Rep C with Rep A for one live prospecting block', 'Manager', 'Jul 21'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Outbound touches, meetings, and contact coverage per rep.', 'Updated 6h ago'],
      ['CRM', 'Open pipeline per rep for normalising activity.', 'Updated 6h ago'],
      ['Slack', 'Nudges delivered to frontline managers.', 'Weekly · Monday'],
    ],
    banner: '🎉 7 reps benchmarked · 1 coaching plan issued · 3 actions assigned',
  },

  '11-deal-hygiene-audit': {
    eyebrow: 'Pipeline hygiene audit',
    title: 'Deal hygiene — 42 open opportunities scanned',
    sub: 'Checked every open deal for stale close dates, missing next steps, thin threading, and blank fields.',
    pill: '9 flagged · 33 clean',
    stats: [
      ['🔍', '42', 'Opportunities scanned'],
      ['🚩', '9', 'Deals flagged'],
      ['📆', '4', 'Past close date'],
      ['🏆', '2', 'Reps fully clean'],
    ],
    summary:
      'Nine of forty-two open deals fail hygiene checks, and four of them are already past their close date without an update — those either move or get lost. Three are missing a documented next step and two commit-stage deals have a blank amount, which distorts the forecast directly. Reps A and D are clean; send the per-rep list to managers for a Friday cleanup.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Hygiene failures',
        count: '9 of 42 opportunities',
        head: ['Severity', 'Issue', num('Deals'), 'Impact', 'Fix'],
        rows: [
          [high('High'), 'Past close date, not updated', num('4'), 'Forecast overstated', 'Push the date or close the deal'],
          [high('High'), 'Amount blank on commit-stage deals', num('2'), 'Commit number is wrong', 'Enter the amount today'],
          [med('Medium'), 'No documented next step', num('3'), 'Deals age silently', 'Add a dated next step'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Per-rep breakdown',
        heading: '👤 Where the issues sit',
        count: '5 reps with findings',
        head: ['Rep', num('Flagged'), 'Dominant issue'],
        rows: [
          ['Rep C', num('4'), 'Past close date'],
          ['Rep F', num('3'), 'No next step'],
          ['Rep B', num('2'), 'Blank amount on commit'],
          [dim('Rep A'), num('0'), dim('Clean')],
          [dim('Rep D'), num('0'), dim('Clean')],
        ],
      },
      actionPlan([
        ['Update or close the 4 past-date deals', 'Reps C, F', 'Friday'],
        ['Enter amounts on the 2 commit-stage deals before the forecast call', 'Rep B', 'Jul 17'],
        ['Add dated next steps to the 3 flagged deals', 'Rep F', 'Friday'],
      ]),
    ],
    evidence: [
      ['CRM', 'Open opportunities, stage, amount, and close date.', 'Updated 5h ago'],
      ['Backstory MCP', 'Engagement recency and contact coverage per deal.', 'Updated 2h ago'],
      ['Slack', 'Per-rep lists delivered to reps and managers.', 'Monday 07:00'],
    ],
    banner: '🎉 42 deals scanned · 9 flagged · Cleanup assigned before Friday',
  },

  '12-win-loss-debrief': {
    eyebrow: 'Win/loss debrief',
    title: 'ManpowerGroup — WON, $494.5K',
    sub: 'Reconstructed the full engagement timeline from first touch to close and analysed what moved the deal.',
    pill: 'Closed won · 112-day cycle',
    stats: [
      ['🏆', 'WON', 'Outcome'],
      ['💰', '$494.5K', 'Deal value'],
      ['📆', '112', 'Days in cycle'],
      ['🤝', '3', 'Contacts engaged'],
    ],
    summary:
      'We won on executive sponsorship and speed through security. Olivia Jenkins stayed engaged from week two onward, the security review cleared in nine days, and the real-time analytics demo was the deciding factor against the incumbent. The avoidable cost was procurement: three weeks were added because paper started after the technical win rather than in parallel — start it earlier next time.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Turning points',
        count: '4 moments',
        head: ['Phase', 'What happened', 'Effect', 'Date'],
        rows: [
          [high('Won it'), 'Real-time analytics demo versus incumbent', 'Champion converted to advocate', dim('Apr 22')],
          [high('Won it'), 'Executive sponsor engaged from week 2', 'Kept velocity through 2 stalls', dim('Mar 14')],
          [med('Cost us'), 'Procurement started after technical win', 'Added 3 weeks to the cycle', dim('Jun 3')],
          [dim('Neutral'), 'Two support escalations during evaluation', 'Resolved in 4 days, no impact', dim('May 9')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Engagement pattern',
        heading: '📈 Multi-threading effectiveness',
        count: '3 contacts across 112 days',
        head: ['Contact', 'Role', 'Engagement', 'Contribution'],
        rows: [
          ['Olivia Jenkins', high('Economic buyer'), '100%', 'Cleared budget and timeline'],
          ['Janet Anderson', 'Champion', '92%', 'Drove the analytics use case internally'],
          ['Elizabeth Moore', med('Compliance'), '34%', 'Gate on security; cleared in 9 days'],
        ],
      },
      actionPlan([
        ['Add "start procurement in parallel with the technical win" to the playbook', 'Enablement', 'Jul 21'],
        ['Record the analytics demo as a reusable enablement asset', 'Enablement', 'Jul 24'],
        ['Share the debrief in the enablement channel', 'Manager', 'Today'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Full engagement timeline: meetings, emails, contacts, cadence.', 'Full deal cycle'],
      ['CRM', 'Stage history and close event webhook.', 'Triggered on close'],
      ['Slack', 'Debrief delivered to rep, manager, and #enablement.', 'Delivered'],
    ],
    banner: '🎉 Debrief generated on close · 2 replicable plays captured · 1 process fix logged',
  },

  '13-competitive-displacement-alert': {
    eyebrow: 'Competitive intelligence alert',
    title: '🚨 Displacement signal — Keyslogic',
    sub: 'Correlated an engagement drop with competitor mentions across email, meetings, and CRM notes.',
    pill: 'HIGH risk · Renewal in 90 days',
    stats: [
      ['📉', '-40%', 'Engagement, 2 weeks'],
      ['🗣️', '3', 'Competitor mentions'],
      ['📅', '90d', 'To renewal'],
      ['🛡️', 'HIGH', 'Displacement risk'],
    ],
    summary:
      'Keyslogic shows the two signals that matter together: engagement fell 40% in two weeks while a competitor was named three times across meetings and CRM notes. Elizabeth Moore raised fault-tolerance concerns on the last call, which is the same objection the alternative leads with. With the renewal 90 days out, this needs executive escalation and tailored reliability proof points this week, not at renewal time.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Signals detected',
        count: '4 signals correlated',
        head: ['Weight', 'Signal', 'Evidence', 'Source'],
        rows: [
          [high('Strong'), 'Engagement collapse', 'Down 40% over 14 days across all contacts.', dim('Backstory MCP')],
          [high('Strong'), 'Competitor named', 'Mentioned in 2 meeting titles and 1 CRM note.', dim('Meetings · CRM')],
          [med('Moderate'), 'Objection alignment', 'Fault tolerance raised by Elizabeth Moore on Jul 9.', dim('Meeting notes')],
          [med('Moderate'), 'Contract timing', 'Renewal window opens in 90 days.', dim('CRM')],
        ],
      },
      actionPlan([
        ['Escalate to the executive sponsor with a reliability brief', 'Sales leader', 'Today'],
        ['Build tailored fault-tolerance proof points and uptime data', 'Solutions', 'Jul 18'],
        ['Book a technical deep dive with Elizabeth Moore', 'AE', 'This week'],
      ]),
      {
        kind: 'note',
        heading: '🧯 Defensive play',
        body:
          'Lead with measured uptime and failover architecture rather than feature comparison — the objection is reliability, not capability. Bring a reference customer of similar scale, and land the executive conversation before the competitor’s evaluation completes.',
      },
    ],
    evidence: [
      ['Backstory MCP', 'Engagement trend and contact-level drop-off.', 'Updated 1h ago'],
      ['CRM notes', 'Competitor mentions and objection history.', 'Jul 9'],
      ['Slack', 'Alert sent immediately to owner and manager.', 'Real time'],
    ],
    banner: '🚨 High-risk signal · Exec escalation opened · Reliability proof points assigned',
  },

  '14-territory-heat-map': {
    eyebrow: 'Territory intelligence',
    title: 'Territory heat map — James, week of Jul 13',
    sub: 'Scored week-over-week momentum for every account in the territory and grouped by trend.',
    pill: '3 hot · 2 warm · 6 cold',
    stats: [
      ['🔥', '3', 'Heating up'],
      ['🌤', '2', 'Warm, no open deal'],
      ['❄️', '6', 'Cold 30d+'],
      ['📈', '+12%', 'Territory momentum'],
    ],
    summary:
      'Territory momentum is up 12% week over week, driven by three hot accounts that already have open pipeline. The opportunity this week is the warm band: Five9 and Dropbox Paper are engaged with no open opportunity, which is the fastest path to new pipeline. Six accounts have been cold for 30 days or more and should be batched into a single re-engagement sequence rather than worked individually.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Momentum by account',
        count: '11 of 24 accounts moved',
        head: ['Band', 'Account', 'Week-over-week', 'Open pipeline', 'Why'],
        rows: [
          [high('🔥 Hot'), 'ManpowerGroup', '+18%', '$494.5K', 'Meeting frequency rising, exec engaged'],
          [high('🔥 Hot'), 'ABBYY', '+22%', '—', 'Two new contacts engaged this week'],
          [high('🔥 Hot'), 'HFF', '+15%', '$60K', 'Champion promoted, inbound up'],
          [med('🌤 Warm'), 'Five9', '+6%', '—', 'Expanded usage, no open opportunity'],
          [med('🌤 Warm'), 'Dropbox Paper', '+4%', '—', 'Engaged contacts, single product'],
          [dim('❄️ Cold'), '6 accounts', '0%', '—', 'No activity in 30+ days'],
        ],
      },
      actionPlan([
        ['Convert the 2 warm whitespace accounts into discovery calls', 'James', 'This week'],
        ['Keep weekly cadence on the 3 hot accounts', 'James', 'Ongoing'],
        ['Batch the 6 cold accounts into one re-engagement sequence', 'James', 'Jul 22'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Engagement volume and contact growth per account.', 'Updated 3h ago'],
      ['CRM', 'Open pipeline coverage per territory account.', 'Updated 3h ago'],
      ['Slack', 'Heat map delivered Monday morning.', 'Weekly'],
    ],
    banner: '🎉 24 accounts scored · 3 hot · 2 whitespace conversions targeted',
  },

  '15-qbr-auto-prep': {
    eyebrow: 'Quarterly business review pack',
    title: 'ManpowerGroup — Q3 QBR prep',
    sub: 'Compiled the full quarter of engagement, relationship changes, and deal progression 48 hours ahead.',
    pill: 'GREEN health · QBR in 48h',
    stats: [
      ['💰', '$494.5K', 'ARR'],
      ['📉', '100% → 9%', 'Engagement trend'],
      ['🪑', '2 of 5', 'Seats adopted'],
      ['📅', 'Feb', 'Renewal'],
    ],
    summary:
      'Health is green on commercial terms and amber on usage. The quarter delivered two clear wins — the security review passed and two new use cases went live — but engagement fell from 100% at signing to 9%, and only two of five seats are adopted. Frame the QBR around expanding to five teams and getting executive alignment on the analytics roadmap, using the two live use cases as proof.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Quarter in review',
        count: '6 findings',
        head: ['Type', 'Item', 'Evidence', 'Source'],
        rows: [
          [high('Win'), 'Security review passed', 'Cleared Jul 12 with no findings.', dim('Salesforce')],
          [high('Win'), '2 new use cases live', 'Forecast roll-ups and deal reviews in production.', dim('Product usage')],
          [med('Risk'), 'Seat adoption at 2 of 5', 'Three seats never activated since signing.', dim('Product usage')],
          [med('Risk'), 'Engagement down to 9%', 'Champion quiet for 3 weeks.', dim('Backstory MCP')],
          [dim('Context'), 'Renewal in February', 'No discount requested to date.', dim('CRM')],
          [dim('Context'), '14 meetings this quarter', 'Down from 22 in Q2.', dim('Calendar')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🎤 Talking points and asks',
        count: '3 asks',
        head: ['#', 'Ask', 'Supporting proof'],
        rows: [
          [dim('1'), 'Expand to 5 teams', 'ROI from the 2 live use cases'],
          [dim('2'), 'Executive alignment on the analytics roadmap', 'Stated need from Janet Anderson'],
          [dim('3'), 'Activate the 3 dormant seats', 'Adoption plan with the admin'],
        ],
      },
      actionPlan([
        ['Circulate the QBR pack to the account team', 'CSM', '48h before'],
        ['Pre-align with the champion on the expansion ask', 'AE', 'Jul 18'],
        ['Prepare the ROI slide from the 2 live use cases', 'CSM', 'Jul 18'],
      ]),
    ],
    evidence: [
      ['Calendar', 'QBR meetings identified by title pattern.', '48h lead time'],
      ['Backstory MCP', 'Quarter of meetings, email volume, and contacts engaged.', 'Q3 to date'],
      ['CRM', 'ARR, deal progression, and renewal timing.', 'Updated 4h ago'],
    ],
    banner: '🎉 QBR pack delivered 48h early · 2 wins documented · 3 asks prepared',
  },

  '16-executive-sponsor-tracker': {
    eyebrow: 'Executive coverage report',
    title: 'Executive sponsor tracker — strategic deals',
    sub: 'Checked VP+ engagement on every open deal above the strategic value threshold.',
    pill: '1 healthy · 1 at risk · 1 gap',
    stats: [
      ['👔', '3', 'Strategic deals'],
      ['✅', '1', 'Sponsor healthy'],
      ['⚠️', '1', 'Sponsor silent'],
      ['❌', '1', 'No sponsor mapped'],
    ],
    summary:
      'Only one of three strategic deals has a genuinely healthy executive relationship. Twitch is at risk — Dorian Quinn has not been touched in 18 days and no meeting is booked, on a $313K renewal. ABBYY is worse in a quieter way: there is no executive sponsor identified at all, so the deal is running entirely on practitioner support. Map one this week before discovery goes further.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Sponsor coverage',
        count: '3 deals above threshold',
        head: ['Status', 'Account', 'Sponsor', 'Last touch', num('Value'), 'Next meeting'],
        rows: [
          [dim('HEALTHY'), 'ManpowerGroup', 'Olivia Jenkins', '3 days ago', num('$494.5K'), 'Today 2:00 PM'],
          [high('AT RISK'), 'Twitch Interactive', 'Dorian Quinn', '18 days ago', num('$313K'), 'None booked'],
          [med('GAP'), 'ABBYY', 'None identified', '—', num('$210K'), 'Map this week'],
        ],
      },
      actionPlan([
        ['Book an executive check-in with Dorian Quinn', 'AE', 'This week'],
        ['Map and engage an executive sponsor at ABBYY', 'AE', 'Jul 21'],
        ['Keep the weekly ManpowerGroup exec cadence', 'AE', 'Ongoing'],
      ]),
      {
        kind: 'note',
        heading: '🎚️ Threshold in use',
        body:
          'Deals above the strategic value threshold are tracked for VP+ engagement. A sponsor is flagged AT RISK after 14 days with no meeting or email, and as a GAP when no VP+ contact has ever engaged on the opportunity.',
      },
    ],
    evidence: [
      ['CRM', 'Open deals above the configured value threshold.', 'Updated 4h ago'],
      ['Backstory MCP', 'VP+ contact engagement and title resolution.', 'Updated 1h ago'],
      ['Slack', 'Alerts sent to deal owners and sales leadership.', 'Delivered'],
    ],
    banner: '🎉 3 strategic deals checked · 1 escalation raised · 1 sponsor-mapping task assigned',
  },

  '17-marketing-sales-handoff-scorer': {
    eyebrow: 'Lead handoff report',
    title: 'MQL handoff — 5 leads scored',
    sub: 'Checked each new MQL against existing relationship history before routing it to a seller.',
    pill: '2 hot · 1 warm · 2 nurture',
    stats: [
      ['🔥', '2', 'Hot handoffs'],
      ['🌤', '1', 'Warm'],
      ['🌱', '2', 'Nurture'],
      ['⚡', '92', 'Top score'],
    ],
    summary:
      'Two of five leads are far warmer than the marketing source suggests. Andrew Wright at ABBYY scores 92 because the account is already engaged and he sits on the buying committee — that is an immediate AE call, not an SDR sequence. Two leads have no relationship footprint and generic titles, so they belong in nurture. Hot leads were assigned round-robin at handoff time.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Scored handoffs',
        count: '5 leads',
        head: ['Band', 'Lead', 'Account context', num('Score'), 'Route'],
        rows: [
          [high('HOT'), 'A. Wright', 'ABBYY — engaged account, buying committee', num('92'), 'Route to AE now'],
          [high('HOT'), 'G. Roberts', 'ABBYY — second committee member', num('86'), 'Route to same AE'],
          [med('WARM'), 'M. Patel', 'Five9 — customer, new department', num('64'), 'SDR with account context'],
          [dim('NURTURE'), 'J. Doe', 'Unknown company, generic title', num('34'), 'Marketing nurture'],
          [dim('NURTURE'), 'R. Sato', 'No Backstory footprint', num('28'), 'Marketing nurture'],
        ],
      },
      actionPlan([
        ['Call A. Wright with the existing account context in hand', 'AE (round-robin)', 'Today'],
        ['Brief the SDR on the Five9 relationship before outreach', 'SDR manager', 'Jul 17'],
        ['Return the 2 nurture leads to the marketing sequence', 'Marketing ops', 'Automatic'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Prior meetings, threads, contacts, and past opportunities.', 'Real time'],
      ['CRM / marketing automation', 'New MQL creation events and lead fields.', 'On create'],
      ['Slack', 'Context brief delivered instantly to the receiving seller.', 'Real time'],
    ],
    banner: '🎉 5 leads scored · 2 hot routed to AEs · 0 warm leads worked as cold',
  },

  '18-channel-pulse': {
    eyebrow: 'Account channel update',
    title: '#account-manpowergroup — 60-second update',
    sub: 'Summarised the last 7 days of account activity for the extended team and executives.',
    pill: 'Last 7 days · On track',
    stats: [
      ['💰', '$494.5K', 'New Business'],
      ['📈', '100%', 'Engagement'],
      ['📅', 'Oct 15', 'Close date'],
      ['🗓️', '4', 'Touches this week'],
    ],
    summary:
      'The deal is progressing on schedule: the security review passed and the SOW is now with legal, leaving procurement timing as the only open variable for the Oct 15 close. Engagement stayed at 100% across three contacts with four touches this week. No action is needed from the extended team — this is a status read.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 What happened this week',
        count: '4 updates',
        head: ['Type', 'Update', 'When'],
        rows: [
          [high('Progress'), 'Security review passed with no findings', dim('Jul 12')],
          [high('Progress'), 'SOW sent to legal for review', dim('Jul 14')],
          [med('Watch'), 'Procurement timeline still unconfirmed', dim('Open since Jul 9')],
          [dim('Context'), 'Exec sponsor meeting held', dim('Jul 13')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Account facts',
        heading: '🧾 At a glance',
        count: 'Owner + terms',
        head: ['Field', 'Value'],
        rows: [
          ['Owner', 'Olivia Jenkins (economic buyer)'],
          ['Deal', 'New Business · $494.5K · closes Oct 15'],
          ['Stage', 'Negotiation — paper in legal'],
          ['Watch item', 'Procurement timeline'],
        ],
      },
    ],
    evidence: [
      ['Backstory MCP', 'Account activity for the last 7 days.', 'Updated 1h ago'],
      ['CRM', 'Deal terms, stage, and owner.', 'Updated 1h ago'],
      ['Slack', 'Posted to the account channel.', 'Weekly'],
    ],
    banner: '🎉 7-day update posted · 2 wins · 1 watch item · No action required',
  },
}
