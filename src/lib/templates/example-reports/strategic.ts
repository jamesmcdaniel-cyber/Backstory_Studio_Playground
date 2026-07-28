import { actionPlan, dim, high, med, num } from './report-builder'
import type { ReportSpec } from './report-builder'

/** Strategic intelligence, on-demand briefs, and orchestration templates (29–38). */
export const STRATEGIC_SPECS: Record<string, ReportSpec> = {
  '29-digital-chief-of-staff': {
    eyebrow: 'Executive daily brief',
    title: 'Digital Chief of Staff — brief for James',
    sub: 'Combined account-channel updates, calendar prep, inbox triage, and pipeline state into one brief.',
    pill: '3 moves today · 3 meetings prepped',
    stats: [
      ['🎯', '3', 'Moves that matter'],
      ['📅', '3', 'Meetings today'],
      ['📥', '3', 'Inbox items need you'],
      ['💰', '$3.8M', 'Pipeline in view'],
    ],
    summary:
      'Three moves decide the day: get the ManpowerGroup SOW into legal, re-engage the Twitch executive before the renewal slips further, and open discovery on ABBYY while the account is hot. Your calendar has three meetings and each has a brief attached. Inbox triage surfaced three items that genuinely need you; the rest are summarized and archived.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🎯 Top 3 moves today',
        count: 'Ranked by revenue impact',
        head: ['#', 'Move', 'Why now', num('At stake')],
        rows: [
          [dim('1'), 'Send the ManpowerGroup SOW to legal', 'Only step between here and the Oct 15 close', num('$494.5K')],
          [dim('2'), 'Re-engage the Twitch executive sponsor', 'No exec touch in 18 days on a slipping renewal', num('$313K')],
          [dim('3'), 'Open discovery on ABBYY', 'Two engaged contacts, no open opportunity', num('$210K')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Calendar',
        heading: '📅 Today’s meetings',
        count: '3 meetings · briefs attached',
        head: ['Time', 'Meeting', 'Prep status', 'One thing to land'],
        rows: [
          ['09:30', 'Team West forecast call', high('Brief ready'), 'Push 3 sandbagged best-case deals'],
          ['14:00', 'ManpowerGroup — Olivia Jenkins', high('Brief ready'), 'Confirm the procurement timeline'],
          ['16:00', 'Pipeline review with the manager', high('Brief ready'), 'Flag Slice and Twitch renewals'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '⚠️ Pipeline watch',
        count: '2 at-risk deals',
        head: ['Risk', 'Account', num('Value'), 'Signal'],
        rows: [
          [high('HIGH'), 'Twitch Interactive', num('$313K'), '10% engaged, no exec touch in 18 days'],
          [med('MEDIUM'), 'Slice', num('$117K'), '0% engaged, renewal past close date'],
        ],
      },
    ],
    evidence: [
      ['Backstory MCP', 'Account, opportunity, and engagement enrichment.', 'Updated 30m ago'],
      ['Calendar', 'Today’s meetings, attendees, and prep windows.', 'Updated 30m ago'],
      ['Slack', 'Account-channel updates and brief delivery.', '06:00 MT'],
    ],
    banner: '🎉 Brief delivered 06:00 · 3 moves ranked · 3 meetings prepped · 2 risks flagged',
  },

  '30-market-research-brief': {
    eyebrow: 'Market intelligence brief',
    title: 'Target accounts — market signals this week',
    sub: 'Combined external company signals with Backstory relationship and opportunity context.',
    pill: '3 accounts · 3 actionable signals',
    stats: [
      ['📰', '3', 'Accounts with signals'],
      ['📈', '1', 'Expansion signal'],
      ['🛡️', '1', 'Security angle'],
      ['💸', '1', 'Cost-pressure angle'],
    ],
    summary:
      'Each of the three target accounts changed in a way that should change your message. ManpowerGroup announced a Q3 hiring surge, which is a direct expansion trigger on a live deal. ABBYY hired a new CISO, so security-led messaging will land where it previously did not. Twitch is reported to be cutting costs — lead with ROI there rather than capability.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Signals and what to do with them',
        count: '3 signals',
        head: ['Type', 'Account', 'Signal', 'Message shift', 'Source'],
        rows: [
          [high('Expansion'), 'ManpowerGroup', 'Announced Q3 hiring surge', 'Seat expansion, scale story', dim('Public filing')],
          [high('Security'), 'ABBYY', 'New CISO hired', 'Lead with security posture', dim('Press · Jul 11')],
          [med('Cost'), 'Twitch Interactive', 'Cost-cutting reported', 'Lead with ROI, not features', dim('Press · Jul 10')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Relationship context',
        heading: '🤝 Where we stand',
        count: '3 accounts',
        head: ['Account', 'Status', 'Engaged contacts', 'Open pipeline'],
        rows: [
          ['ManpowerGroup', high('Active deal'), '3 contacts, 100% engaged', num('$494.5K')],
          ['ABBYY', med('Engaged, no deal'), 'Andrew Wright, Gregory Roberts', num('—')],
          ['Twitch Interactive', med('Renewal at risk'), '1 contact, 10% engaged', num('$313K')],
        ],
      },
      actionPlan([
        ['Attach the hiring-surge angle to the ManpowerGroup expansion case', 'AE', 'Jul 18'],
        ['Send the security brief to the new ABBYY CISO', 'AE', 'Jul 18'],
        ['Rebuild the Twitch renewal deck around ROI', 'AE', 'Jul 21'],
      ]),
    ],
    evidence: [
      ['External signals', 'Normalized company-signal packets from public sources.', 'Weekly sweep'],
      ['Backstory MCP', 'Relationship and opportunity context per account.', 'Updated 2h ago'],
      ['Slack + email', 'Brief delivered to the account team.', 'Weekly · Monday'],
    ],
    banner: '🎉 3 signals matched to live accounts · 3 message shifts recommended',
  },

  '31-deal-inspection': {
    eyebrow: 'Deal inspection',
    title: '/dealcheck ManpowerGroup — New Business',
    sub: 'Resolved the account and opportunity, pulled deal context, and returned risk with next actions.',
    pill: 'Risk LOW · Answered in Slack',
    stats: [
      ['💰', '$494.5K', 'Deal value'],
      ['📅', 'Oct 15', 'Close date'],
      ['📈', '100%', 'Engagement'],
      ['🛡️', 'LOW', 'Risk'],
    ],
    summary:
      'This deal is healthy on every axis that predicts a close: full engagement across three contacts, an active executive sponsor, and paper already in legal. Risk is low and the only dependency is the legal review landing this week. MEDDPICC is complete except paper, which is in flight.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Deal state',
        count: '5 attributes',
        head: ['Attribute', 'Value', 'Read'],
        rows: [
          ['Stage', 'Negotiation', high('On track')],
          ['Next step', 'Legal review this week', high('Documented')],
          ['Threading', '3 contacts engaged', high('Multi-threaded')],
          ['Executive sponsor', 'Olivia Jenkins — active', high('Engaged')],
          ['Owner', 'James McDaniel', dim('Assigned')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Qualification',
        heading: '✅ MEDDPICC',
        count: '3 complete · 1 in flight',
        head: ['Element', 'Status', 'Evidence'],
        rows: [
          ['Metrics', high('✅ Complete'), 'ROI model agreed on the analytics use case.'],
          ['Economic buyer', high('✅ Complete'), 'Olivia Jenkins engaged weekly.'],
          ['Champion', high('✅ Complete'), 'Janet Anderson driving internally.'],
          ['Paper process', med('🟡 In legal'), 'SOW sent Jul 14; review due this week.'],
        ],
      },
      actionPlan([
        ['Confirm the legal review completes this week', 'James', 'Jul 18'],
        ['Lock the procurement timeline with Olivia Jenkins', 'James', 'Jul 18'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Deal context, engagement, and contact roles.', 'Real time'],
      ['CRM', 'Stage, amount, close date, and next step.', 'Real time'],
      ['Slack', 'Answered in-channel from the slash command.', '< 10s'],
    ],
    banner: '🎉 Deal inspected on demand · Risk LOW · 2 next actions returned',
  },

  '32-revenue-orchestration': {
    eyebrow: 'Approval-gated action',
    title: 'Proposed CRM update — ManpowerGroup',
    sub: 'Built a proposed CRM update and owner message from an external signal; paused for approval.',
    pill: 'Awaiting approval · Nothing written yet',
    stats: [
      ['⏸️', '1', 'Action pending'],
      ['📝', '3', 'Field changes proposed'],
      ['✉️', '1', 'Owner message drafted'],
      ['🔒', '0', 'Writes executed'],
    ],
    summary:
      'The security review passing is a stage-advancing signal, so the agent assembled the corresponding CRM update and a message to the owner — and stopped there. Nothing has been written to the CRM and no message has been sent. Approve to apply all three changes as one transaction, or edit any field before approving.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Signal that triggered this',
        count: '1 signal',
        head: ['Signal', 'Evidence', 'Source', 'Confidence'],
        rows: [
          ['Security review passed', 'Cleared with no findings on Jul 12.', dim('Salesforce · Jul 12'), high('High')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Pending approval',
        heading: '📝 Proposed changes',
        count: '3 changes · not applied',
        head: ['#', 'Field', 'Current', 'Proposed'],
        rows: [
          [dim('1'), 'Stage', 'Technical validation', high('Negotiation')],
          [dim('2'), 'Next step', '(empty)', high('Legal review by Fri')],
          [dim('3'), 'Notification', 'None', high('Notify Olivia Jenkins')],
        ],
      },
      {
        kind: 'note',
        heading: '✉️ Drafted owner message',
        body:
          '“Security review cleared with no findings — moving this to Negotiation. SOW goes to legal today with review targeted for Friday, which keeps the Oct 15 go-live intact. Flag anything you want changed before it goes out.”',
      },
      {
        kind: 'note',
        heading: '🔒 Approval required',
        body:
          '▶ Approve to apply · ✎ Edit before applying · ✕ Discard. No CRM write or outbound message occurs until approval is recorded in Slack; the proposal expires after 24 hours.',
      },
    ],
    evidence: [
      ['External signal', 'Security review completion event.', 'Jul 12'],
      ['Backstory MCP', 'Deal context used to build the proposal.', 'Updated 1h ago'],
      ['Slack', 'Approval prompt posted to the owner.', 'Awaiting response'],
    ],
    banner: '⏸️ Awaiting approval · 3 changes staged · 0 writes executed',
  },

  '33-prospecting-brief': {
    eyebrow: 'Prospecting brief',
    title: 'ABBYY — outreach angles and next steps',
    sub: 'Combined account status, recent activity, and situation context into tailored outreach angles.',
    pill: 'Engaged, no open deal · Brief ready',
    stats: [
      ['👥', '2', 'Engaged contacts'],
      ['📊', '3', 'Recent buying signals'],
      ['💰', '$210K', 'Estimated whitespace'],
      ['🎯', '2', 'Outreach angles'],
    ],
    summary:
      'ABBYY is engaged but unclaimed: Andrew Wright and Gregory Roberts are active, there are two site visits and a pricing-page view in the last two weeks, and there is no open opportunity. Two angles fit the current situation — real-time analytics, which matches their stated need, and security, which lands differently now that they have a new CISO. Open with their Q3 hiring surge.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Buying signals',
        count: '3 signals in 14 days',
        head: ['Weight', 'Signal', 'Detail', 'Source'],
        rows: [
          [high('Strong'), 'Two engaged contacts', 'Andrew Wright and Gregory Roberts, both replying.', dim('Backstory MCP')],
          [high('Strong'), 'Pricing-page view', 'Jul 12, from a known contact.', dim('Web activity')],
          [med('Moderate'), '2 site visits', 'Product and security pages.', dim('Web activity')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🎯 Outreach angles',
        count: '2 angles · 1 opener',
        head: ['#', 'Angle', 'Why it fits', 'Target'],
        rows: [
          [dim('1'), 'Real-time analytics', 'Matches the stated need and the pricing-page interest.', 'Gregory Roberts'],
          [dim('2'), 'Security posture', 'New CISO hired this month.', 'New CISO'],
        ],
      },
      {
        kind: 'note',
        heading: '✉️ Suggested opening',
        body:
          '“Saw the Q3 hiring surge — teams scaling that fast usually hit the same reporting bottleneck. Two of your people have been looking at how we handle real-time analytics; happy to show what that looks like at your headcount rather than in a generic demo.”',
      },
      actionPlan([
        ['Email Gregory Roberts with the analytics angle', 'AE', 'Today'],
        ['Send the security brief to the new CISO', 'AE', 'Jul 18'],
        ['Log the opportunity once a first meeting is booked', 'AE', 'On booking'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Account status, contacts, and recent activity.', 'Updated 1h ago'],
      ['Web activity', 'Site visits and pricing-page views by known contacts.', 'Last 14 days'],
      ['Slack', 'Brief delivered on request with contacts and draft.', 'On demand'],
    ],
    banner: '🎉 Brief delivered · 3 signals evidenced · 2 angles and a draft prepared',
  },

  '34-manager-coaching-brief': {
    eyebrow: 'Manager coaching brief',
    title: 'Rep C — coaching brief for this week',
    sub: 'Combined opportunity status, scorecard signal, and situation context into coaching points.',
    pill: '3 coaching points · $620K book',
    stats: [
      ['💰', '$620K', 'Pipeline'],
      ['📂', '6', 'Open opportunities'],
      ['🧵', '2', 'Single-threaded deals'],
      ['📉', 'Below', 'Activity vs median'],
    ],
    summary:
      'Rep C carries $620K across six opportunities, but the book has two structural weaknesses: activity is below the team median and two deals are single-threaded, including the largest. The fastest correction is multi-threading ManpowerGroup, then enforcing documented next steps across the whole book. Two executive meetings this week would close the activity gap on its own.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Book review',
        count: '6 opportunities',
        head: ['Flag', 'Deal', num('Value'), 'Contacts', 'Issue'],
        rows: [
          [high('Coach'), 'ManpowerGroup expansion', num('$240K'), num('1'), 'Single-threaded on the largest deal'],
          [high('Coach'), 'Falken Group', num('$95K'), num('1'), 'Single-threaded, no next step'],
          [med('Watch'), 'Dropbox Paper', num('$110K'), num('2'), 'No next step documented'],
          [dim('Healthy'), '3 other deals', num('$175K'), num('3+'), 'Normal threading and cadence'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🎓 Coaching points',
        count: '3 points',
        head: ['#', 'Point', 'Talk track'],
        rows: [
          [dim('1'), 'Multi-thread ManpowerGroup', '“Who signs, who blocks, who benefits — name all three this week.”'],
          [dim('2'), 'Set next steps on all opportunities', '“No meeting ends without a dated next step.”'],
          [dim('3'), 'Book two executive meetings', '“Use the champion to get one level up.”'],
        ],
      },
      actionPlan([
        ['Run the multi-threading exercise in the 1:1', 'Manager', 'Jul 17'],
        ['Review documented next steps on all 6 deals', 'Rep C', 'Jul 18'],
        ['Book 2 executive meetings', 'Rep C', 'This week'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Engagement, threading, and activity per opportunity.', 'Updated 2h ago'],
      ['Scorecard', 'Activity benchmark against the team median.', 'Weekly'],
      ['Slack', 'Brief delivered to the rep and manager.', 'On demand'],
    ],
    banner: '🎉 Coaching brief delivered · 3 points with talk tracks · 3 actions assigned',
  },

  '35-grounded-follow-up': {
    eyebrow: 'Grounded content draft',
    title: 'Follow-up draft — ManpowerGroup',
    sub: 'Drafted a follow-up grounded in the last call, deal-risk context, and cited evidence.',
    pill: 'Draft ready · 2 sources cited',
    stats: [
      ['✉️', '1', 'Draft ready'],
      ['🔗', '2', 'Evidence citations'],
      ['📅', 'Oct 15', 'Target go-live'],
      ['🚫', '0', 'Unsupported claims'],
    ],
    summary:
      'The draft references only what actually happened: the security items closed on the Jul 3 call and ticket #482 was resolved. It commits to the revised SOW and a Friday legal review, which are the two things the buyer asked for, and keeps the Oct 15 go-live in view. Nothing in the message asserts a fact the run could not source.',
    sections: [
      {
        kind: 'note',
        heading: '✉️ Draft — “Next steps after your security review”',
        body:
          'Hi Olivia — great to close out the security items today. As discussed, I’ve attached the revised SOW reflecting the analytics scope. Next: legal review by Friday, targeting the Oct 15 go-live. Anything you need from me before then?',
      },
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 What grounds each claim',
        count: '4 claims · all sourced',
        head: ['Claim in the draft', 'Grounded in', 'Source'],
        rows: [
          ['“close out the security items today”', 'Security review completed with no findings.', dim('Call · Jul 3')],
          ['“revised SOW reflecting the analytics scope”', 'Scope change agreed on the same call.', dim('Meeting notes')],
          ['“legal review by Friday”', 'Next step recorded on the opportunity.', dim('CRM')],
          ['“targeting the Oct 15 go-live”', 'Close date on the opportunity.', dim('CRM')],
        ],
      },
      actionPlan([
        ['Review, personalise, and send the draft', 'James', 'Today'],
        ['Attach the revised SOW before sending', 'James', 'Today'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Recent opportunity activity and deal-risk context.', 'Updated 1h ago'],
      ['Meeting record', 'Jul 3 call transcript and agreed actions.', 'Jul 3'],
      ['Support', 'Ticket #482 resolution.', 'Jul 11'],
    ],
    banner: '🎉 Draft generated · 4 claims cited · 0 unsupported statements',
  },

  '36-pipeline-forecast-digest': {
    eyebrow: 'Pipeline intelligence report',
    title: 'Pipeline & forecast digest',
    sub: 'Pulled top records, expanded every at-risk opportunity, and ranked the forecast issues.',
    pill: '$3.8M in view · 2 gaps',
    stats: [
      ['💰', '$3.8M', 'Total pipeline'],
      ['📂', '39', 'Open opportunities'],
      ['✅', '$1.2M', 'Commit'],
      ['📈', '$1.9M', 'Best case'],
    ],
    summary:
      'The book holds $3.8M across 20 accounts and 39 open opportunities, with $1.2M in commit and $1.9M best case. Two renewals account for nearly all of the forecast risk: Twitch at $313K with 10% engagement and Slice at $117K, overdue with no engagement at all. Slice is the biggest single gap — it is past close with zero activity, which means it is either a save play or a subtraction from the number.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 At-risk opportunities (expanded)',
        count: '2 of 39 opportunities',
        head: ['Risk', 'Opportunity', num('Value'), 'Engagement', 'Why it is at risk'],
        rows: [
          [high('HIGH'), 'Twitch Interactive renewal', num('$313K'), '10%', 'No exec touch in 18 days; champion quiet'],
          [high('HIGH'), 'Slice renewal', num('$117K'), '0%', 'Past close date with no activity in 21 days'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Forecast composition',
        heading: '📊 Where the number comes from',
        count: '20 accounts',
        head: ['Category', num('Value'), num('Deals'), 'Read'],
        rows: [
          ['Commit', num('$1.2M'), num('7'), '2 deals below 20% engagement'],
          ['Best case', num('$1.9M'), num('12'), '3 fully engaged past close — push to commit'],
          ['Pipeline', num('$3.8M'), num('39'), 'Across 20 accounts'],
        ],
      },
      actionPlan([
        ['Open a save play on the Slice renewal', 'CSM', 'Today'],
        ['Escalate the Twitch renewal to the executive sponsor', 'AE', 'This week'],
        ['Review the 3 push candidates in the forecast call', 'Manager', 'Jul 18'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Engagement enrichment on every expanded opportunity.', 'Updated 2h ago'],
      ['CRM', 'Forecast category, amount, stage, and close date.', 'Updated 2h ago'],
      ['Slack', 'Digest posted with at-risk deals expanded.', 'Delivered'],
    ],
    banner: '🎉 39 opportunities reviewed · 2 risks expanded · 3 push candidates flagged',
  },

  '37-deal-risk-next-actions': {
    eyebrow: 'Deal risk brief',
    title: 'Twitch Interactive — renewal at risk',
    sub: 'Merged opportunity status, recent activity, engaged-person context, and situation evidence.',
    pill: 'Risk HIGH · 3 next actions',
    stats: [
      ['🛡️', 'HIGH', 'Risk level'],
      ['💰', '$313K', 'Renewal value'],
      ['📉', '10%', 'Engagement'],
      ['📆', '18d', 'Since exec touch'],
    ],
    summary:
      'This renewal is failing on three independent signals at once: the champion has gone quiet, a competitor was mentioned on the last recorded call, and the close date has already passed with engagement at 10%. Any one of those is recoverable; together they mean the renewal is being decided without us in the room. Escalate to the executive sponsor this week and lead with the ROI recap.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Risk drivers',
        count: '3 drivers',
        head: ['Weight', 'Driver', 'Evidence', 'Source'],
        rows: [
          [high('Strong'), 'Champion quiet', 'No reply in 18 days from Dorian Quinn.', dim('Backstory MCP')],
          [high('Strong'), 'Competitor mentioned', 'Named on the last recorded call.', dim('Meeting notes')],
          [med('Moderate'), 'Past close date', 'Close date passed with engagement at 10%.', dim('CRM')],
        ],
      },
      actionPlan([
        ['Escalate to Dorian Quinn with an executive-level ask', 'Sales leader', 'This week'],
        ['Send the ROI recap covering the last contract term', 'AE', 'Jul 18'],
        ['Book the renewal review before the end of the week', 'AE', 'Jul 18'],
      ]),
      {
        kind: 'note',
        heading: '🧭 If nothing changes',
        body:
          'With no executive contact and a passed close date, the realistic outcome is a lapsed renewal or a heavily discounted short-term extension. The decision point is this week — after that the buyer’s evaluation cycle closes without our input.',
      },
    ],
    evidence: [
      ['Backstory MCP', 'Engagement recency and engaged-person context.', 'Updated 1h ago'],
      ['CRM', 'Renewal value, stage, and close date.', 'Updated 1h ago'],
      ['Meeting record', 'Competitor mention on the last recorded call.', 'Jun 28'],
    ],
    banner: '🚨 Risk HIGH · 3 drivers evidenced · Executive escalation opened',
  },

  '38-account-planning-strategy': {
    eyebrow: 'Account plan',
    title: 'ManpowerGroup — account strategy',
    sub: 'Combined account status, activity, stakeholder engagement, and situation context into priorities.',
    pill: '$989K total · 3 plays',
    stats: [
      ['💰', '$989K', 'Total account value'],
      ['🧭', '$200K', 'Whitespace identified'],
      ['👥', '2', 'Key stakeholders'],
      ['🎯', '3', 'Plays this quarter'],
    ],
    summary:
      'ManpowerGroup carries $494.5K of New Business plus an equal renewal, with engagement split sharply between the two — 100% on the new deal and 9% on the renewal, which is the single biggest risk in the account. Whitespace is real: three teams are not using analytics, worth roughly $200K. The strategy is sequential — land the go-live, prove ROI on the two live use cases, then expand in Q4.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Account position',
        count: '4 dimensions',
        head: ['Dimension', 'Current state', 'Read'],
        rows: [
          ['New Business', '$494.5K, 100% engaged, closes Oct 15', high('Strong')],
          ['Renewal', '$494.5K, 9% engaged, renews Feb', high('At risk')],
          ['Whitespace', '3 teams without analytics (~$200K)', med('Opportunity')],
          ['Adoption', '2 of 5 seats active', med('Soft')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Buying committee',
        heading: '👥 Stakeholders',
        count: '2 mapped · 1 gap',
        head: ['Name', 'Role', 'Stance', 'Play'],
        rows: [
          ['Olivia Jenkins', high('Economic buyer'), 'Supportive, weekly cadence', 'Keep on the go-live plan'],
          ['Elizabeth Moore', med('Blocker'), 'Compliance concerns', 'Close out in the security review'],
          [dim('Analytics team lead'), dim('Unmapped'), dim('Unknown'), 'Map before the Q4 expansion push'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Recommended execution',
        heading: '🎯 Plays this quarter',
        count: '3 plays · sequenced',
        head: ['#', 'Play', 'Goal', 'By'],
        rows: [
          [dim('1'), 'Land the Oct 15 go-live', 'Convert the New Business deal cleanly', 'Q3'],
          [dim('2'), 'Prove ROI on the 2 live use cases', 'Arm the renewal conversation', 'Q4 start'],
          [dim('3'), 'Expand analytics to 3 dormant teams', 'Capture the $200K whitespace', 'Q4'],
        ],
      },
      actionPlan([
        ['Close the compliance items with Elizabeth Moore', 'Solutions', 'Jul 18'],
        ['Build the ROI model from the 2 live use cases', 'CSM', 'Aug 1'],
        ['Map the analytics team lead as a second champion', 'AE', 'Aug 8'],
      ]),
    ],
    evidence: [
      ['Backstory MCP', 'Account activity, stakeholders, and engagement split.', 'Updated 2h ago'],
      ['CRM', 'Deal values, renewal timing, and ownership.', 'Updated 2h ago'],
      ['Product usage', 'Seat and feature adoption by team.', 'Jul 13'],
    ],
    banner: '🎉 Account plan delivered · $200K whitespace quantified · 3 plays sequenced',
  },
}
