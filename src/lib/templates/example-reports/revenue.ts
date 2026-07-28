import { actionPlan, dim, high, med, num } from './report-builder'
import type { ReportSpec } from './report-builder'

/** Upsell, digest, pipeline, and account-monitoring templates (39, 40, 01–09). */
export const REVENUE_SPECS: Record<string, ReportSpec> = {
  '39-salesai-upsell-engine': {
    eyebrow: 'Upsell intelligence report',
    title: 'SalesAI Upsell Engine — Weekly Sweep',
    sub: 'Scored the in-segment account universe across readiness, competitive risk, use-case fit, and sales motion.',
    pill: '18 of 23 scored · Action ready',
    stats: [
      ['🏆', '6', 'Accounts ready NOW'],
      ['📈', '64', 'Avg readiness score'],
      ['💰', '$2.1M', 'Qualified pipeline'],
      ['⚠️', '3', 'Competitive eval signals'],
    ],
    summary:
      'Scored 18 of 23 in-segment accounts (5 lacked usage data). Six are ready now, led by Seismic (91) with an engaged champion and peaking usage. Three accounts show live competitive evaluations and two show engagement decay. Recommended focus this week: close the Seismic expansion while re-engaging the two decaying renewals before the signals compound.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Priority matrix',
        count: 'Top 5 of 18 scored',
        head: ['Tier', 'Account', num('Readiness'), 'Comp. risk', 'Primary use case'],
        rows: [
          [high('NOW'), 'Seismic', num('91'), 'Medium', 'Forecast roll-ups'],
          [high('NOW'), 'Zscaler', num('88'), 'High', 'Pipeline inspection'],
          [high('NOW'), 'CrowdStrike', num('84'), 'Medium', 'Deal reviews'],
          [med('NEXT'), 'Palo Alto Networks', num('79'), 'Medium', 'Renewal save plan'],
          [med('NEXT'), 'Datadog', num('76'), 'Low', 'Deal reviews'],
        ],
        note: 'Tiering: NOW ≥ 80 with an engaged champion · NEXT 65–79 · NURTURE 50–64 · MONITOR &lt; 50 or insufficient data.',
      },
      {
        kind: 'table',
        eyebrow: 'Buying committee',
        heading: '👥 Stakeholder list',
        count: 'Named for the 3 NOW accounts',
        head: ['Account', 'Decision maker', 'Role', 'Entry point'],
        rows: [
          ['Seismic', 'Janet Anderson', 'VP Revenue Ops (champion)', 'Warm — met twice in 30 days'],
          ['Zscaler', 'Gregory Roberts', 'Sr. Director Sales Strategy', 'Champion intro via RevOps'],
          ['CrowdStrike', 'Andrew Wright', 'Economic buyer', 'Cold — no exec touch yet'],
        ],
      },
      actionPlan([
        ['Book Seismic expansion review with the engaged champion', 'Account team', 'Jul 16'],
        ["Counter Zscaler's live competitive evaluation with ROI brief", 'Solutions', 'Jul 17'],
        ['Re-engage the two decaying renewals with usage health review', 'CSM', 'Jul 18'],
        ['Map an executive sponsor at CrowdStrike before discovery', 'AE', 'Jul 21'],
      ]),
      {
        kind: 'note',
        heading: '📮 Executive digest (emailed)',
        body:
          'Segment health is improving: average readiness rose 6 points week over week and qualified pipeline crossed $2.1M. Top five are Seismic, Zscaler, CrowdStrike, Palo Alto Networks, and Datadog. Risk themes are competitive evaluations (3 accounts) and engagement decay on renewals (2 accounts). Recommended focus: convert Seismic this week — it is the only account with readiness above 90 and an active champion.',
      },
    ],
    evidence: [
      ['Backstory MCP', 'Opportunity data and 30-day communications intelligence.', 'Updated 2h ago'],
      ['Snowflake', 'Feature adoption and usage telemetry per account.', 'Jul 13'],
      ['Salesforce', 'Stage history, ARR, and named stakeholders.', 'Updated 2h ago'],
      ['Data gaps', '5 accounts skipped — no usage telemetry in the last 90 days.', 'Flagged this run'],
    ],
    banner:
      '🎉 18 accounts scored · Priority matrix delivered · Executive digest emailed · Slack summary posted',
  },

  '40-upsell-account-scorer': {
    eyebrow: 'Account readiness scorecard',
    title: 'ManpowerGroup — SalesAI upsell readiness',
    sub: 'Scored one account across data quality, feature maturity, AI use-case fit, and account health.',
    pill: '91 / 100 · High confidence',
    stats: [
      ['🎯', '91', 'Overall readiness'],
      ['🧬', '95', 'Data quality'],
      ['🧩', '96', 'AI use-case fit'],
      ['🛡️', 'LOW', 'Risk level'],
    ],
    summary:
      'ManpowerGroup scores 91 with high confidence — full CRM coverage, recent activity, and a stated real-time analytics need from Janet Anderson. Feature maturity is the one soft spot: core is adopted but analytics is untouched, which is exactly the whitespace SalesAI fills. One compliance concern from Elizabeth Moore should be routed into the security review before the value conversation.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Sub-scores',
        count: '4 dimensions scored',
        head: ['Dimension', num('Score'), 'Rationale', 'Source'],
        rows: [
          ['Data quality / coverage', num('95'), 'Full account + opportunity coverage, activity within 3 days.', dim('Backstory MCP')],
          ['Feature maturity', num('72'), 'Core adopted; analytics module unused — whitespace.', dim('Snowflake · Jul 13')],
          ['AI use-case fit', num('96'), 'Real-time analytics need stated by Janet Anderson on the Jul 3 call.', dim('Meeting intelligence')],
          ['Account health', num('90'), '100% engaged on New Business, ARR trending up.', dim('Salesforce')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Risk assessment',
        heading: '⚠️ Risk flags',
        count: '1 open · 0 blocking',
        head: ['Flag', 'Severity', 'What the evidence says'],
        rows: [
          [med('Compliance'), 'Medium', 'Elizabeth Moore raised data-privacy questions; unresolved since Jul 9.'],
          [dim('Churn'), 'None', 'Engagement steady at 100%; no competitor mentions in 90 days.'],
          [dim('Competitive'), 'None', 'No displacement signals in email, meetings, or CRM notes.'],
        ],
      },
      actionPlan(
        [
          ['Book an exec value review with Olivia Jenkins (EB) on the analytics use case', 'AE', 'Jul 18'],
          ["Route Elizabeth Moore's compliance questions into the security review", 'Solutions', 'Jul 17'],
        ],
        'Single recommended next action first',
      ),
    ],
    evidence: [
      ['Backstory MCP', 'Engagement history, contacts, and opportunity state.', 'Updated 2h ago'],
      ['Snowflake', 'Seat and feature adoption telemetry.', 'Jul 13'],
      ['Salesforce', 'ARR, stage, and owner assignment.', 'Updated 2h ago'],
    ],
    banner: '🎉 Readiness 91/100 · Whitespace identified · Exec value review recommended',
  },

  '01-sales-digest': {
    eyebrow: 'Daily sales digest',
    title: 'Good morning, James — 3 accounts need attention',
    sub: 'Scanned your enrolled accounts, opportunities, and engagement activity from the last 24 hours.',
    pill: '3 of 20 need action · Delivered 06:00 MT',
    stats: [
      ['💰', '$3.8M', 'Pipeline in view'],
      ['🏢', '20', 'Accounts scanned'],
      ['🔥', '1', 'Deal with momentum'],
      ['⚠️', '2', 'Slipping deals'],
    ],
    summary:
      'Momentum is concentrated in ManpowerGroup, where the $494.5K New Business deal is fully engaged and moving toward an Oct 15 close — confirm legal review this week. The risk is on the renewal side: Twitch has had no executive touch in 12 days and Slice is past close with zero engagement. Everything else in the $3.8M book is steady, so spend the day on the two renewals.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Accounts that need you',
        count: '3 of 20 accounts',
        head: ['Priority', 'Account', 'Deal', num('Value'), 'Signal'],
        rows: [
          [high('High'), 'ManpowerGroup', 'New Business · closes Oct 15', num('$494.5K'), '100% engaged — confirm legal review'],
          [high('High'), 'Twitch Interactive', 'Renewal · slipping', num('$313K'), '10% engaged, no exec touch in 12 days'],
          [med('Medium'), 'Slice', 'Renewal · overdue', num('$117K'), '0% engaged — flag to manager'],
        ],
      },
      actionPlan([
        ['Confirm legal review timing with Olivia Jenkins', 'James', 'Today'],
        ['Schedule an exec check-in on the Twitch renewal', 'James', 'Jul 17'],
        ['Escalate the overdue Slice renewal to the manager', 'James', 'Jul 17'],
      ]),
      {
        kind: 'note',
        heading: '📊 Rest of book',
        body:
          '17 accounts show no change worth your time today: 11 steady, 4 in early discovery with next steps already set, and 2 closed-won inside the last week and handed to CS. No new risks entered the book overnight.',
      },
    ],
    evidence: [
      ['Backstory MCP', 'Account, opportunity, and engagement activity for enrolled users.', 'Updated 15m ago'],
      ['User config store', 'Digest subscriber list and delivery preferences.', 'Jul 14'],
      ['Slack', 'Delivered to #sales-james at 06:00 MT.', 'Receipt confirmed'],
    ],
    banner: '🎉 20 accounts scanned · 3 flagged · Digest delivered to #sales-james',
  },

  '02-meeting-brief': {
    eyebrow: 'Meeting brief',
    title: 'ManpowerGroup — today, 2:00 PM MT',
    sub: 'Assembled attendee context, deal state, and what changed since the last meeting.',
    pill: 'Brief ready · 45 min before start',
    stats: [
      ['👥', '3', 'Attendees'],
      ['💰', '$494.5K', 'Deal value'],
      ['📈', '100%', 'Engagement'],
      ['📅', 'Oct 15', 'Close date'],
    ],
    summary:
      'You are meeting the economic buyer with two supporting stakeholders on a fully engaged $494.5K New Business deal. Since the last meeting the security review closed and two support tickets were resolved, which removes the blocker Elizabeth Moore raised — lead with that. The open question is procurement timing, and it is the one thing that can move the Oct 15 go-live.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Who is in the room',
        heading: '👥 Attendees',
        count: '3 attendees resolved',
        head: ['Name', 'Role', 'Last touch', 'What they care about'],
        rows: [
          ['Olivia Jenkins', high('Economic buyer'), '3 days ago', 'Go-live date and total cost'],
          ['Elizabeth Moore', med('Compliance blocker'), '8 days ago', 'Data privacy and retention'],
          ['Janet Anderson', 'VP Revenue Ops (champion)', '2 days ago', 'Real-time analytics rollout'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Since the last meeting',
        count: '4 changes',
        head: ['Change', 'Detail', 'Source'],
        rows: [
          [high('Resolved'), 'Security review completed — no findings.', dim('Salesforce · Jul 12')],
          [high('Resolved'), '2 support tickets closed (#482, #491).', dim('Support · Jul 11')],
          [med('Open'), 'Procurement timeline not confirmed.', dim('Meeting notes · Jul 9')],
          [dim('Steady'), 'Engagement held at 100% across 3 contacts.', dim('Backstory MCP')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🗒️ Suggested agenda',
        count: '3 items · 30 min',
        head: ['#', 'Agenda item', 'Goal'],
        rows: [
          [dim('1'), 'Close out the security follow-ups', 'Confirm the compliance concern is retired'],
          [dim('2'), 'Confirm the procurement timeline', 'Named date for paper to legal'],
          [dim('3'), 'Align on go-live scope', 'Agreement on Oct 15 and analytics rollout'],
        ],
      },
    ],
    evidence: [
      ['Calendar', 'Meeting time, attendees, and title match.', '45m before start'],
      ['Backstory MCP', 'Engagement history and contact roles.', 'Updated 20m ago'],
      ['Salesforce', 'Stage, amount, close date, and activity log.', 'Updated 1h ago'],
    ],
    banner: '🎉 Brief delivered to the meeting owner · 3 agenda items · 1 open risk flagged',
  },

  '03-silence-contract-monitor': {
    eyebrow: 'Engagement risk alert',
    title: 'Silence & Contract Monitor — 2 accounts went quiet',
    sub: 'Checked 20 monitored accounts for engagement gaps against deal stage and contract dates.',
    pill: '2 flagged · 18 healthy',
    stats: [
      ['🔇', '2', 'Accounts silent'],
      ['💰', '$117K', 'Revenue at risk'],
      ['📆', '21d', 'Longest silence'],
      ['✅', '18', 'No action needed'],
    ],
    summary:
      'Two accounts crossed the silence threshold, and only one is genuinely dangerous: Slice has had no activity in 21 days while sitting inside its renewal window with a past-due close date, which puts $117K at high churn risk. Falken Group is a softer signal — no executive touch since the security review, recoverable with a call this week. The other 18 monitored accounts show normal cadence.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Silent accounts',
        count: '2 of 20 monitored',
        head: ['Risk', 'Account', 'Deal', num('Value'), 'Silence', 'Why it matters'],
        rows: [
          [high('HIGH'), 'Slice', 'Renewal · closes Dec 29', num('$117K'), '21 days', 'Inside renewal window at 0% engagement'],
          [med('MEDIUM'), 'Falken Group', 'Expansion · discovery', num('—'), '11 days', 'No exec touch since the security review'],
        ],
      },
      actionPlan([
        ['Open a save play on the Slice renewal and involve the manager', 'CSM', 'Today'],
        ['Book a call with the Falken Group executive sponsor', 'AE', 'Before Friday'],
      ]),
      {
        kind: 'note',
        heading: '📊 Threshold applied',
        body:
          'Silence is measured as no meaningful two-way engagement — meeting, reply, or inbound — within 14 days, weighted by deal stage. Accounts inside a renewal window trip the alert at 7 days. Severity escalates when contract dates fall inside the next 90 days.',
      },
    ],
    evidence: [
      ['Backstory MCP', 'Engagement recency and contact-level activity.', 'Updated 30m ago'],
      ['Salesforce', 'Contract dates, renewal windows, and stage.', 'Updated 1h ago'],
      ['Slack', 'Alert routed to owning reps and CSMs.', 'Delivered 06:30 MT'],
    ],
    banner: '🎉 20 accounts checked · 2 flagged · Save play opened on Slice',
  },

  '04-opportunity-discovery': {
    eyebrow: 'Whitespace intelligence',
    title: 'Opportunity Discovery — 3 hidden opportunities this week',
    sub: 'Cross-referenced engagement activity against the open pipeline to find accounts buying without a deal.',
    pill: '3 surfaced · $200K+ top estimate',
    stats: [
      ['🕵️', '3', 'Hidden opportunities'],
      ['💰', '$200K+', 'Top whitespace estimate'],
      ['🏢', '34', 'Accounts cross-referenced'],
      ['🎯', '1', 'Assign this week'],
    ],
    summary:
      'Three accounts are showing buying behaviour with nothing in the pipeline to match it. ABBYY is the standout: two engaged contacts including a buying-committee member, no open opportunity, and an estimated $200K+ of whitespace. Five9 and HFF are real but earlier — expanded usage and a promoted champion respectively. Assign ABBYY for discovery this week and keep the other two on the nurture track.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Signals without a deal',
        count: '3 of 34 accounts',
        head: ['Priority', 'Account', 'Signal', num('Est. value'), 'Engaged contacts'],
        rows: [
          [high('Top pick'), 'ABBYY', 'High engagement, no open opportunity', num('$200K+'), 'Andrew Wright, Gregory Roberts'],
          [med('Next'), 'Five9', 'Expanded usage, single product today', num('$90K'), '1 admin, 1 economic buyer'],
          [med('Next'), 'HFF', 'Champion promoted — warm intro path opened', num('$60K'), '1 champion'],
        ],
      },
      actionPlan([
        ['Assign ABBYY for discovery and book a first call', 'AE', 'Jul 18'],
        ['Send the Five9 cross-sell one-pager to the admin', 'AE', 'Jul 21'],
        ['Ask the HFF champion for the warm intro to their VP Eng', 'AE', 'Jul 22'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Contact-level engagement and meeting activity.', 'Updated 2h ago'],
      ['CRM pipeline', 'Open-opportunity coverage per account.', 'Updated 2h ago'],
      ['Slack + email', 'Curated list delivered to the rep and manager.', 'Weekly · Monday'],
    ],
    banner: '🎉 34 accounts cross-referenced · 3 opportunities surfaced · 1 assigned for discovery',
  },

  '05-forecast-coach': {
    eyebrow: 'Forecast coaching report',
    title: 'Team West — weekly pipeline coaching',
    sub: 'Assessed every open deal on engagement recency, stakeholder coverage, stage velocity, and risk.',
    pill: '$1.2M commit · 2 deals at risk',
    stats: [
      ['💰', '$1.2M', 'Commit (7 deals)'],
      ['📈', '$1.9M', 'Best case'],
      ['⚠️', '2', 'At-risk commit deals'],
      ['🪜', '3', 'Sandbagging signals'],
    ],
    summary:
      'Commit is $1.2M across seven deals, but two of them sit below 20% engagement with no executive sponsor — that is the exposure to coach out this week. In the other direction, three best-case deals are fully engaged and past their close date, which reads as sandbagging and should be pushed to commit. The structural gap across the team is Rep D, whose deals all lack a documented next step.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Deals that move the number',
        count: '5 of 14 open deals',
        head: ['Call', 'Deal', num('Value'), 'Engagement', 'Coaching point'],
        rows: [
          [high('Commit · at risk'), 'Twitch Interactive renewal', num('$313K'), '10%', 'No exec sponsor — secure one or downgrade'],
          [high('Commit · at risk'), 'Keyslogic expansion', num('$180K'), '18%', 'Single-threaded; competitor mentioned'],
          [med('Best case · push'), 'ABBYY new business', num('$210K'), '100%', 'Past close date, fully engaged — move to commit'],
          [med('Best case · push'), 'Five9 cross-sell', num('$90K'), '92%', 'Paper in legal — commit-worthy'],
          [dim('Healthy'), 'ManpowerGroup new business', num('$494.5K'), '100%', 'On track for Oct 15'],
        ],
      },
      actionPlan([
        ['Run a sponsor-mapping exercise on the 2 at-risk commit deals', 'Manager', 'Jul 17'],
        ['Review the 3 sandbagged best-case deals in the forecast call', 'Manager', 'Jul 18'],
        ["Require a documented next step on all of Rep D's deals", 'Rep D', 'Jul 18'],
      ]),
      {
        kind: 'note',
        heading: '🎓 Coaching focus this week',
        body:
          "Rep D's entire book lacks documented next steps, which is why their deals age faster than the team median. Pair the next-step requirement with one multi-threading exercise per deal — the team's healthiest deals average 3.4 engaged contacts versus 1.2 on Rep D's.",
      },
    ],
    evidence: [
      ['Backstory MCP', 'Engagement recency and stakeholder coverage per deal.', 'Updated 3h ago'],
      ['CRM', 'Forecast category, amount, stage, and close date.', 'Updated 3h ago'],
      ['Email', 'Per-leader coaching report delivered Monday 07:00.', 'Weekly'],
    ],
    banner: '🎉 14 deals assessed · 2 risks surfaced · 3 push candidates identified',
  },

  '06-executive-inbox': {
    eyebrow: 'Inbox triage report',
    title: 'Executive Inbox — 14 unread, 3 need you',
    sub: 'Read unread messages, matched senders to CRM accounts, and classified each by urgency and category.',
    pill: '3 escalated · 11 auto-handled',
    stats: [
      ['📥', '14', 'Unread scanned'],
      ['🚩', '3', 'Need your reply'],
      ['💰', '$494.5K', 'Largest deal touched'],
      ['🗂️', '11', 'Summarized + archived'],
    ],
    summary:
      'Three of fourteen unread messages need you personally, and one is time-sensitive: Olivia Jenkins is asking for the revised SOW on the $494.5K ManpowerGroup deal. The ABBYY security questionnaire is routable to the solutions engineer without your involvement, and the HFF champion offering an introduction to their VP Eng is worth a personal reply today. The other eleven were summarized and archived.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Messages that need you',
        count: '3 of 14',
        head: ['Urgency', 'From', 'Account context', 'Ask', 'Route'],
        rows: [
          [high('Today'), 'Olivia Jenkins', 'ManpowerGroup · $494.5K, closes Oct 15', 'Revised SOW', 'Reply personally'],
          [med('This week'), 'procurement@abbyy', 'ABBYY · engaged, no open opp', 'Security questionnaire', 'Route to SE'],
          [med('This week'), 'Champion, HFF', 'HFF · warm intro path open', 'Intro to their VP Eng', 'Reply personally'],
        ],
      },
      actionPlan([
        ['Send the revised SOW to Olivia Jenkins', 'James', 'Today'],
        ['Hand the ABBYY security questionnaire to the SE', 'James', 'Jul 17'],
        ['Accept the HFF intro and propose two times', 'James', 'Jul 17'],
      ]),
      {
        kind: 'note',
        heading: '🗂️ Auto-handled',
        body:
          '11 messages required no action: 4 newsletters, 3 calendar confirmations, 2 automated CRM notifications, and 2 internal FYIs already covered in the daily digest. Each was summarized in one line and archived; nothing was deleted.',
      },
    ],
    evidence: [
      ['Email', 'Unread messages and sender identities.', 'Updated 10m ago'],
      ['Backstory MCP', 'Account history matched to each sender domain.', 'Updated 30m ago'],
      ['Slack', 'Escalations routed to #sales-james and the SE channel.', 'Delivered'],
    ],
    banner: '🎉 14 messages triaged · 3 escalated · 11 archived with summaries',
  },

  '07-churn-risk-scorecard': {
    eyebrow: 'Customer success scorecard',
    title: 'Weekly churn risk — CS team',
    sub: 'Scored every customer account on engagement trend, support volume, champion activity, and usage.',
    pill: '2 red · 4 amber · 31 green',
    stats: [
      ['🔴', '2', 'Red accounts'],
      ['🟠', '4', 'Amber accounts'],
      ['🟢', '31', 'Green accounts'],
      ['📉', 'Slice', 'Biggest mover'],
    ],
    summary:
      'Two accounts are red this week. Slice moved down from amber on zero engagement and an overdue renewal, and Acme joined it after support escalations tripled. Four amber accounts share the same three drivers — declining logins, a departed executive sponsor, and an NPS drop. The single highest-value action is a save play plus executive outreach on Slice before the renewal date passes.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Accounts at risk',
        count: '6 of 37 scored',
        head: ['Band', 'Account', num('Risk'), 'Top driver', 'Save play'],
        rows: [
          [high('RED'), 'Slice', num('9/10'), '0% engaged, renewal overdue', 'Exec outreach + value review'],
          [high('RED'), 'Acme', num('8/10'), 'Support escalations up 3×', 'Escalation review with support lead'],
          [med('AMBER'), 'Keyslogic', num('6/10'), 'Exec sponsor departed', 'Re-map the buying committee'],
          [med('AMBER'), 'Falken Group', num('6/10'), 'Logins down 40%', 'Adoption workshop'],
          [med('AMBER'), 'Dropbox Paper', num('5/10'), 'NPS dropped 2 points', 'Feedback call'],
          [med('AMBER'), 'Twitch Interactive', num('5/10'), 'No exec touch in 18 days', 'Renewal review'],
        ],
      },
      actionPlan([
        ['Open the Slice save play and schedule executive outreach', 'CS manager', 'Today'],
        ['Run an escalation review on Acme with the support lead', 'CSM', 'Jul 17'],
        ['Re-map the Keyslogic buying committee after the sponsor exit', 'CSM', 'Jul 21'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Engagement trend and champion contact activity.', 'Updated 4h ago'],
      ['CRM', 'Renewal dates, ARR, and support ticket volume.', 'Updated 4h ago'],
      ['Slack', 'Scorecard delivered to CS managers, ranked by severity.', 'Weekly · Monday'],
    ],
    banner: '🎉 37 accounts scored · 2 red · Save play opened on the biggest mover',
  },

  '08-renewal-prep-brief': {
    eyebrow: 'Renewal prep brief',
    title: 'ManpowerGroup — renewal in 30 days',
    sub: 'Assembled contract terms, engagement trend, usage, and risk ahead of the Feb 20 renewal.',
    pill: 'T-30 · Action required',
    stats: [
      ['💰', '$494.5K', 'Contract value'],
      ['📅', 'Feb 20', 'Renewal date'],
      ['📉', '9%', 'Engagement (was 100%)'],
      ['🪑', '2 of 5', 'Seats active'],
    ],
    summary:
      'The contract is healthy on paper and weak in practice: $494.5K renewing on Feb 20, but engagement has collapsed from 100% at signing to 9%, and only two of five seats are active. The champion has been quiet for three weeks and a competitor was mentioned on the last call. Schedule a value review now, lead with ROI data on the two active teams, and re-engage the executive sponsor before the 15-day mark.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Health signals',
        count: '5 signals',
        head: ['Signal', 'Reading', 'Trend', 'Source'],
        rows: [
          [high('Engagement'), '9% of contacts active', 'Down from 100% at signing', dim('Backstory MCP')],
          [high('Champion'), 'Quiet for 3 weeks', 'Last reply Jun 24', dim('Email')],
          [med('Adoption'), '2 of 5 seats active', 'Core features only', dim('Product usage')],
          [med('Competitive'), 'Alternative mentioned on last call', 'New this quarter', dim('Meeting notes')],
          [dim('Commercial'), '$494.5K, no discount requested', 'Stable', dim('CRM')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🧭 Renewal strategy',
        count: '3 plays · T-30 to T-15',
        head: ['#', 'Play', 'Goal', 'By'],
        rows: [
          [dim('1'), 'Value review with the account team', 'Quantify ROI on the 2 active teams', 'T-25'],
          [dim('2'), 'Re-engage the executive sponsor', 'Reopen the exec relationship', 'T-20'],
          [dim('3'), 'Adoption plan for the 3 dormant seats', 'Remove the usage objection', 'T-15'],
        ],
      },
      actionPlan([
        ['Schedule the value review and send the ROI pack', 'CSM', 'T-25'],
        ['Request an executive sponsor meeting through the champion', 'AE', 'T-20'],
        ['Build the seat-activation plan with the admin', 'CSM', 'T-15'],
      ]),
    ],
    evidence: [
      ['CRM', 'Contract value, renewal date, and expansion history.', 'Updated 6h ago'],
      ['Backstory MCP', 'Engagement trend and champion contact recency.', 'Updated 2h ago'],
      ['Support', 'Ticket history and escalation record.', 'Jul 11'],
    ],
    banner: '🎉 Brief delivered to the CSM and AE · 3 plays scheduled · 2 risks flagged',
  },

  '09-onboarding-pulse': {
    eyebrow: 'Onboarding health pulse',
    title: 'First 90 days — day 45 checkpoint',
    sub: 'Checked post-sale engagement on recently closed-won accounts against onboarding milestones.',
    pill: '1 green · 1 amber · 0 red',
    stats: [
      ['🟢', '1', 'On track'],
      ['🟠', '1', 'Needs a nudge'],
      ['📆', '45', 'Days since close'],
      ['🎯', '4 of 5', 'Best milestone progress'],
    ],
    summary:
      'Five9 is exactly where it should be at day 45 — kickoff complete, four of five milestones hit, and daily active usage. NewCo is the concern: onboarding stalled at the integration step and there has been no admin login in ten days, which is the pattern that turns into a retention problem by day 90. A CSM outreach today is enough to correct it.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Accounts in onboarding',
        count: '2 accounts · closed in the last 90 days',
        head: ['Status', 'Account', 'Day', 'Milestones', 'Signal'],
        rows: [
          [high('GREEN'), 'Five9', '45', '4 of 5', 'Daily active; kickoff and training complete'],
          [med('AMBER'), 'NewCo', '38', '2 of 5', 'Stalled at integration; no admin login in 10 days'],
        ],
      },
      actionPlan([
        ['Reach out to the NewCo admin and unblock the integration step', 'CSM', 'Today'],
        ['Book the Five9 day-60 value checkpoint', 'CSM', 'Jul 24'],
      ]),
      {
        kind: 'note',
        heading: '⏱️ Why day 45 matters',
        body:
          'Accounts that miss the integration milestone by day 45 are materially less likely to reach full adoption by day 90, which is when the renewal conversation is framed. The threshold used here is no admin login in 7 days or fewer than 3 milestones at day 45.',
      },
    ],
    evidence: [
      ['CRM', 'Recently closed-won accounts and handoff owners.', 'Updated 5h ago'],
      ['Backstory MCP', 'Post-sale meetings, emails, and contacts engaged.', 'Updated 2h ago'],
      ['Slack', 'Alerts sent to the CSM and sales handoff team.', 'Delivered'],
    ],
    banner: '🎉 2 accounts checked · 1 nudge issued · 0 accounts at 90-day risk',
  },
}
