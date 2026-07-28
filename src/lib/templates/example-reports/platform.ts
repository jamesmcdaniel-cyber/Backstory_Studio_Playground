import { actionPlan, dim, high, med, num } from './report-builder'
import type { ReportSpec } from './report-builder'

/** Platform enablement templates: adapters, contracts, migrations, rollout (19–28). */
export const PLATFORM_SPECS: Record<string, ReportSpec> = {
  '19-customer-stack-blueprint': {
    eyebrow: 'Implementation blueprint',
    title: 'Daily digest to Slack — Acme stack blueprint',
    sub: 'Matched the customer request and tool-stack intake to the closest validated asset and required adapters.',
    pill: '3 patterns reused · 1 adapter to build',
    stats: [
      ['🧩', '3', 'Library patterns reused'],
      ['🔌', '3', 'Adapters required'],
      ['🆕', '1', 'New build needed'],
      ['⏱️', '4', 'Canonical steps'],
    ],
    summary:
      'The request maps cleanly onto the validated daily-digest pattern: Salesforce as CRM, Gong for meetings, Slack for delivery. Three of the four steps reuse library assets unchanged, and only the Gong meeting adapter needs new work before this can ship. Sequence the build so the canonical model and delivery route are validated first, then layer the meeting enrichment.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Canonical pipeline',
        count: '4 steps',
        head: ['#', 'Step', 'Asset', 'Status'],
        rows: [
          [dim('1'), 'Pull accounts and opportunities', 'salesforce→canonical adapter', high('Validated')],
          [dim('2'), 'Enrich with meeting signals', 'gong→canonical adapter', med('New build')],
          [dim('3'), 'Compose the digest', 'digest composition pattern', high('Validated')],
          [dim('4'), 'Route to Slack', 'canonical→slack delivery adapter', high('Validated')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Connector substitutions',
        heading: '🔌 Stack mapping',
        count: '3 systems',
        head: ['Category', 'Customer tool', 'Library equivalent', 'Substitution cost'],
        rows: [
          ['CRM', 'Salesforce', 'salesforce source adapter', dim('None — in library')],
          ['Meetings', 'Gong', 'gong source adapter', med('1 adapter build')],
          ['Delivery', 'Slack', 'slack delivery adapter', dim('None — in library')],
        ],
      },
      actionPlan([
        ['Build and test the gong→canonical adapter', 'Platform', 'Sprint 1'],
        ['Validate steps 1, 3, and 4 with golden payloads', 'Platform', 'Sprint 1'],
        ['Run the rollout readiness scorecard before go-live', 'Solutions', 'Sprint 2'],
      ]),
    ],
    evidence: [
      ['Stack intake', 'Customer tool inventory and delivery preferences.', 'Jul 14'],
      ['Asset library', 'Validated patterns and adapter coverage.', 'Updated Jul 15'],
      ['Backstory MCP', 'Canonical model definitions and field contracts.', 'Schema v2'],
    ],
    banner: '🎉 Blueprint delivered · 3 patterns reused · 1 adapter scoped',
  },

  '20-crm-signal-normalizer': {
    eyebrow: 'Normalization run report',
    title: 'CRM Signal Normalizer — Salesforce → canonical',
    sub: 'Mapped account, contact, opportunity, and activity records onto the canonical schema.',
    pill: '128 records · schema v2 validated',
    stats: [
      ['📦', '128', 'Records normalized'],
      ['🗺️', '4', 'Object types mapped'],
      ['🚩', '12', 'Records flagged'],
      ['✅', 'v2', 'Schema validated'],
    ],
    summary:
      'All 128 Salesforce records normalized against schema v2 and are ready for downstream steps. Twelve records carry data-quality flags rather than mapping failures — seven are missing a close date and five use a custom stage value with no canonical equivalent. The stage values need a mapping table entry before the next run, otherwise those five will keep degrading forecast-dependent workflows.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Field mapping',
        count: '4 object types',
        head: ['Source object', 'Canonical entity', num('Records'), 'Status'],
        rows: [
          ['Opportunity', 'deal', num('39'), high('Mapped')],
          ['Account', 'account', num('20'), high('Mapped')],
          ['Contact', 'person', num('62'), high('Mapped')],
          ['User', 'owner', num('7'), high('Mapped')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Data quality',
        heading: '🚩 Flagged records',
        count: '12 of 128',
        head: ['Severity', 'Issue', num('Records'), 'Downstream impact'],
        rows: [
          [med('Warn'), 'Missing close_date', num('7'), 'Forecast and renewal workflows skip these'],
          [med('Warn'), 'Unmapped stage value', num('5'), 'Stage-based routing falls back to "unknown"'],
        ],
      },
      actionPlan([
        ['Add the 5 custom stage values to the mapping table', 'Platform', 'Before next run'],
        ['Ask the CRM owner to backfill 7 missing close dates', 'Solutions', 'Jul 18'],
      ]),
    ],
    evidence: [
      ['Salesforce', 'Source records via the CRM connector.', 'Updated 20m ago'],
      ['Canonical schema', 'Field contracts and enum definitions.', 'Schema v2'],
      ['Validation log', 'Per-record validation results.', 'This run'],
    ],
    banner: '🎉 128 records normalized · 12 flagged · Downstream steps unblocked',
  },

  '21-meeting-intelligence-normalizer': {
    eyebrow: 'Normalization run report',
    title: 'Meeting Intelligence Normalizer — Gong + Zoom',
    sub: 'Unified meetings, transcripts, attendees, and action items into one meeting-intelligence payload.',
    pill: '9 meetings · 2 systems merged',
    stats: [
      ['🎙️', '9', 'Meetings normalized'],
      ['👥', '23', 'Attendees resolved'],
      ['✅', '14', 'Action items extracted'],
      ['🔗', '3', 'Linked to open deals'],
    ],
    summary:
      'Nine meetings from two note-taker systems now share one payload shape, with 23 of 25 attendees resolved to CRM contacts. Fourteen action items were extracted and three are linked to open opportunities, which is what the prep and coaching workflows consume. The two unresolved attendees are external participants with no CRM record — expected, and flagged rather than guessed.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Extraction summary',
        count: '9 meetings across 2 systems',
        head: ['Source', num('Meetings'), num('Transcripts'), num('Attendees'), num('Action items')],
        rows: [
          ['Gong', num('6'), num('6'), num('16'), num('11')],
          ['Zoom', num('3'), num('3'), num('9'), num('3')],
          [dim('Total'), num('9'), num('9'), num('25'), num('14')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Data quality',
        heading: '🚩 Unresolved items',
        count: '2 of 25 attendees',
        head: ['Severity', 'Item', 'Detail', 'Handling'],
        rows: [
          [med('Warn'), '2 attendees unmatched', 'External participants, no CRM record.', 'Flagged, not guessed'],
          [dim('Info'), '11 action items unlinked', 'No matching open opportunity.', 'Kept at account level'],
        ],
      },
      actionPlan([
        ['Review the 2 unmatched external attendees', 'Solutions', 'Jul 18'],
        ['Release the payload to the digest and brief workflows', 'Platform', 'Automatic'],
      ]),
    ],
    evidence: [
      ['Gong', 'Meetings, transcripts, and action items.', 'Updated 1h ago'],
      ['Zoom', 'Meetings and attendee lists.', 'Updated 1h ago'],
      ['Identity layer', 'Attendee-to-CRM-contact resolution.', 'This run'],
    ],
    banner: '🎉 9 meetings normalized · 23 of 25 attendees resolved · Payload released downstream',
  },

  '22-multi-channel-delivery-router': {
    eyebrow: 'Delivery routing report',
    title: 'Routed insight payload → Slack #sales-james',
    sub: 'Resolved the delivery surface from owner identity, adapted the format, and confirmed receipt.',
    pill: 'Delivered 06:00 MT · Receipt confirmed',
    stats: [
      ['📤', '1', 'Payload routed'],
      ['🎯', 'Slack', 'Resolved surface'],
      ['🧱', 'Blocks', 'Format applied'],
      ['✅', '0', 'Fallbacks used'],
    ],
    summary:
      'The payload resolved to Slack from the owner identity — James McDaniel mapped to a workspace user with #sales-james as the channel fallback — and was formatted as Slack blocks rather than raw text. Delivery succeeded on the first attempt at 06:00 MT with receipt confirmed, so the email fallback was not triggered. No business logic was duplicated for the surface; only the format adapter changed.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Routing decision',
        count: '4 resolution steps',
        head: ['#', 'Step', 'Result', 'Basis'],
        rows: [
          [dim('1'), 'Resolve owner identity', 'James McDaniel → Slack user', dim('Identity layer')],
          [dim('2'), 'Resolve channel', '#sales-james (DM fallback)', dim('Owner preference')],
          [dim('3'), 'Adapt format', 'Slack blocks', dim('Surface capability')],
          [dim('4'), 'Deliver', high('Success — receipt confirmed'), dim('06:00 MT')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Fallback chain',
        heading: '🪜 Configured routes',
        count: '3 routes · 1 used',
        head: ['Order', 'Surface', 'Status'],
        rows: [
          ['Primary', 'Slack', high('Used')],
          ['Secondary', 'Email', dim('Not needed')],
          ['Tertiary', 'Webhook', dim('Not needed')],
        ],
      },
    ],
    evidence: [
      ['Identity layer', 'Owner-to-channel resolution.', 'This run'],
      ['Slack', 'Delivery receipt and message timestamp.', '06:00 MT'],
      ['Routing config', 'Surface preferences and fallback order.', 'Jul 14'],
    ],
    banner: '🎉 Payload delivered on the primary route · Receipt confirmed · 0 fallbacks used',
  },

  '23-identity-resolution-hub': {
    eyebrow: 'Identity resolution report',
    title: 'Identity Resolution Hub — 42 identities resolved',
    sub: 'Unified people, accounts, owners, and channels across CRM, messaging, and meeting systems.',
    pill: '40 resolved · 2 flagged',
    stats: [
      ['🧬', '42', 'Identities processed'],
      ['🔗', '40', 'Resolved to canonical'],
      ['🧹', '3', 'Duplicate accounts merged'],
      ['🚩', '2', 'Unresolved externals'],
    ],
    summary:
      'Forty of forty-two identities resolved to a canonical record, including three duplicate ManpowerGroup account variants that were merged — those duplicates were the cause of the split engagement scores seen in earlier digest runs. Two external participants could not be resolved and are flagged for human review rather than being guessed into a match. The canonical identity map has been updated for downstream workflows.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Resolution samples',
        count: '3 of 40 shown',
        head: ['Type', 'Identity', 'Resolved to', 'Confidence'],
        rows: [
          ['Person', 'Olivia Jenkins', 'SF Contact 003x · Slack @olivia · owner of 2 opps', high('High')],
          ['Account', 'ManpowerGroup (3 variants)', 'Single canonical account', high('High')],
          ['Owner', 'James McDaniel', 'SF User · Slack member · #sales-james', high('High')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Data quality',
        heading: '🚩 Needs review',
        count: '2 identities',
        head: ['Severity', 'Identity', 'Why unresolved'],
        rows: [
          [med('Review'), 'External meeting attendee ×2', 'No CRM record and no domain match; alias ambiguous.'],
        ],
      },
      actionPlan([
        ['Review the 2 unresolved external identities', 'Solutions', 'Jul 18'],
        ['Re-run dependent digests now that duplicates are merged', 'Platform', 'Today'],
      ]),
    ],
    evidence: [
      ['CRM', 'Contacts, accounts, and owner assignments.', 'Updated 2h ago'],
      ['Messaging', 'Workspace members and channel membership.', 'Updated 2h ago'],
      ['Meeting systems', 'Attendee lists and email aliases.', 'Updated 2h ago'],
    ],
    banner: '🎉 40 of 42 identities resolved · 3 duplicates merged · Identity map updated',
  },

  '24-workflow-contract-validator': {
    eyebrow: 'Contract validation report',
    title: 'Contract validation — digest pipeline',
    sub: 'Validated every canonical payload handoff between workflow steps against the declared schema.',
    pill: '1 blocking issue · Fix before rollout',
    stats: [
      ['🔗', '3', 'Handoffs checked'],
      ['❌', '1', 'Blocking failure'],
      ['⚠️', '1', 'Non-breaking drift'],
      ['✅', '1', 'Clean handoff'],
    ],
    summary:
      'One handoff blocks rollout: step 2 emits four records without engagement_score, which step 3 requires, so those records would fail silently in production. The step 3→4 handoff carries an extra legacy_id field, which is drift rather than breakage and can be cleaned up later. Fix the missing field before deploying; everything else matches schema v2.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Handoff results',
        count: '3 handoffs',
        head: ['Result', 'Handoff', 'Detail', 'Action'],
        rows: [
          [dim('✅ Pass'), 'Step 1 → 2', 'Payload matches schema v2 on all 128 records.', dim('None')],
          [high('❌ Fail'), 'Step 2 → 3', 'engagement_score missing on 4 records.', 'Blocking — fix before rollout'],
          [med('⚠️ Warn'), 'Step 3 → 4', 'Extra field legacy_id present (non-breaking).', 'Clean up next sprint'],
        ],
      },
      actionPlan([
        ['Patch step 2 to emit engagement_score for all records', 'Platform', 'Before rollout'],
        ['Remove the legacy_id passthrough from step 3', 'Platform', 'Next sprint'],
        ['Re-run validation and confirm all handoffs pass', 'Platform', 'After patch'],
      ]),
    ],
    evidence: [
      ['Canonical schema', 'Field contracts, enums, and required flags.', 'Schema v2'],
      ['Pipeline run', 'Live payloads captured between steps.', 'This run'],
      ['Validation log', 'Per-record diff against the contract.', 'This run'],
    ],
    banner: '🚩 1 blocking issue found · Rollout held · Fix assigned to platform',
  },

  '25-implementation-gap-audit': {
    eyebrow: 'Implementation gap audit',
    title: 'Dynamics 365 → Teams digest — coverage audit',
    sub: 'Audited the customer request against the current library: validated, recipe-only, or needs build.',
    pill: '2 covered · 2 gaps · build first',
    stats: [
      ['✅', '2', 'Already validated'],
      ['❌', '2', 'Gaps to close'],
      ['🔧', '1', 'New adapter'],
      ['🗺️', '1', 'Mapping task'],
    ],
    summary:
      'Half the request is already productized: the canonical model and the Teams delivery adapter are validated and need no work. The gaps are both on the Dynamics side — there is no source adapter in the library and owner resolution does not handle Dynamics identifiers. That is roughly one adapter build plus a mapping task, and it should be scoped before committing a date to the customer.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Coverage by component',
        count: '4 components audited',
        head: ['Status', 'Component', 'Evidence', 'Effort'],
        rows: [
          [dim('✅ Validated'), 'Canonical account/opp model', 'In production on 3 customers.', dim('None')],
          [dim('✅ Validated'), 'Teams delivery adapter', 'Shipped and regression-covered.', dim('None')],
          [high('❌ Gap'), 'Dynamics 365 source adapter', 'Not present in the library.', '1 adapter build'],
          [high('❌ Gap'), 'Owner resolution for Dynamics ids', 'Identity layer has no Dynamics id handler.', '1 mapping task'],
        ],
      },
      actionPlan([
        ['Scope and estimate the Dynamics 365 source adapter', 'Platform', 'Before commit'],
        ['Extend the identity layer with Dynamics id handling', 'Platform', 'Sprint 1'],
        ['Re-audit once both gaps close', 'Solutions', 'Sprint 2'],
      ]),
    ],
    evidence: [
      ['Asset library', 'Validated assets versus recipe-only coverage.', 'Updated Jul 15'],
      ['Customer request', 'Requested workflow and target stack.', 'Jul 14'],
      ['Identity layer', 'Supported id namespaces.', 'Current'],
    ],
    banner: '🚩 2 gaps identified · Effort scoped · Recommend build before commit',
  },

  '26-orchestrator-migration-planner': {
    eyebrow: 'Migration plan',
    title: 'Salesforce digest → target orchestrator',
    sub: 'Translated a validated workflow pattern into an ordered migration plan with contracts preserved.',
    pill: '3 build steps · 1 validation gate',
    stats: [
      ['🧭', '4', 'Migration steps'],
      ['🗺️', '12', 'Fields to map'],
      ['🚧', '1', 'Risk to mitigate'],
      ['🚦', '1', 'Validation gate'],
    ],
    summary:
      'The pattern migrates in four ordered steps, with workflow order, payload contracts, and delivery behaviour preserved end to end. The one real risk is custom stage values, which have no equivalent in the target and need a mapping table before the first run. Validate with golden payloads at the gate before switching live traffic.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Migration sequence',
        count: '4 steps',
        head: ['#', 'Step', 'Preserves', 'Gate'],
        rows: [
          [dim('1'), 'Deploy the sf-source adapter', 'Source contract', dim('Build')],
          [dim('2'), 'Map 12 fields onto canonical', 'Payload contract', dim('Build')],
          [dim('3'), 'Wire canonical → Slack delivery', 'Delivery behaviour', dim('Build')],
          [dim('4'), 'Replay golden payloads', 'State handling and order', high('Validation gate')],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Risk register',
        heading: '🚧 Risks',
        count: '1 open',
        head: ['Severity', 'Risk', 'Mitigation'],
        rows: [
          [med('Medium'), 'Custom stage values have no target equivalent', 'Build a mapping table before the first run.'],
        ],
      },
      actionPlan([
        ['Build the stage-value mapping table', 'Platform', 'Before step 2'],
        ['Execute steps 1–3 in a staging workspace', 'Platform', 'Sprint 1'],
        ['Run the golden-payload validation gate', 'Platform', 'Before cutover'],
      ]),
    ],
    evidence: [
      ['Source workflow', 'Step order, state handling, and delivery config.', 'Captured Jul 15'],
      ['Asset library', 'Validated pattern the migration targets.', 'Current'],
      ['Golden payloads', 'Regression fixtures for the validation gate.', '40 fixtures'],
    ],
    banner: '🎉 Migration plan delivered · 4 steps sequenced · 1 gate defined',
  },

  '27-adapter-regression-monitor': {
    eyebrow: 'Regression monitor report',
    title: 'Adapter regression — nightly replay',
    sub: 'Replayed golden payloads through the CRM, meeting, identity, and delivery adapters.',
    pill: '38 passed · 2 failed · HIGH severity',
    stats: [
      ['🔁', '40', 'Payloads replayed'],
      ['✅', '38', 'Passed'],
      ['❌', '2', 'Failed'],
      ['🚨', 'HIGH', 'Severity'],
    ],
    summary:
      'Two of forty golden payloads failed and both trace to one cause: the Salesforce adapter stopped emitting next_step after the API v60 change. That field feeds deal-hygiene and coaching workflows, so the blast radius is wider than the failure count suggests. The owner has been paged; the other three adapter families are clean.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Replay results',
        count: '4 adapter families',
        head: ['Result', 'Adapter family', num('Passed'), num('Failed'), 'Detail'],
        rows: [
          [high('❌ Fail'), 'CRM (Salesforce)', num('8'), num('2'), 'next_step dropped after API v60 change'],
          [dim('✅ Pass'), 'Meeting', num('10'), num('0'), 'No drift detected'],
          [dim('✅ Pass'), 'Identity', num('10'), num('0'), 'No drift detected'],
          [dim('✅ Pass'), 'Delivery', num('10'), num('0'), 'No drift detected'],
        ],
      },
      {
        kind: 'table',
        eyebrow: 'Blast radius',
        heading: '💥 Affected workflows',
        count: '3 downstream consumers',
        head: ['Workflow', 'Dependency', 'Impact'],
        rows: [
          ['Deal Hygiene Audit', 'next_step', high('Missing-next-step check invalid')],
          ['Manager Coaching Brief', 'next_step', med('Coaching points degraded')],
          ['Pipeline & Forecast Digest', 'next_step', med('Narrative loses next-step detail')],
        ],
      },
      actionPlan([
        ['Patch the Salesforce adapter for the API v60 field change', 'Adapter owner (paged)', 'Today'],
        ['Re-run the failing golden payloads after the patch', 'Platform', 'Today'],
        ['Add an API-version canary to the nightly replay', 'Platform', 'This sprint'],
      ]),
    ],
    evidence: [
      ['Golden payloads', '40 frozen fixtures covering all adapter families.', 'Nightly'],
      ['Adapter runtime', 'Field-level diff between expected and actual output.', 'This run'],
      ['Alerting', 'Owner paged with failure details attached.', 'Real time'],
    ],
    banner: '🚨 2 regressions caught before customer impact · Owner paged · Patch in progress',
  },

  '28-rollout-readiness-scorecard': {
    eyebrow: 'Rollout readiness scorecard',
    title: 'Acme stack — go-live readiness',
    sub: 'Scored connector access, identity coverage, delivery routes, ownership, security, and QA gates.',
    pill: '78 / 100 · AMBER — fix 2 items',
    stats: [
      ['🎯', '78', 'Readiness score'],
      ['✅', '3', 'Gates passed'],
      ['⚠️', '1', 'Untested'],
      ['❌', '1', 'Missing'],
    ],
    summary:
      'Acme is close but not ready. CRM adapter, identity resolution, and delivery are all validated on their stack, which covers the core path. Two items block go-live: the meeting adapter has never been tested against their Gong instance, and no fallback delivery channel is configured, so a Slack outage would silently drop insights. Fix both and the score clears the green threshold.',
    sections: [
      {
        kind: 'table',
        eyebrow: 'Evidence-backed analysis',
        heading: '🔎 Readiness gates',
        count: '6 gates scored',
        head: ['Status', 'Gate', num('Score'), 'Evidence'],
        rows: [
          [dim('✅ Pass'), 'CRM connector access', num('95'), 'OAuth granted, full object scope verified.'],
          [dim('✅ Pass'), 'Identity coverage', num('90'), '96% of owners resolve to a delivery target.'],
          [dim('✅ Pass'), 'Delivery route', num('88'), 'Slack workspace connected and tested.'],
          [dim('✅ Pass'), 'Ownership assigned', num('85'), 'Named admin and escalation path on record.'],
          [med('⚠️ Untested'), 'Meeting adapter', num('50'), 'Never run against their Gong instance.'],
          [high('❌ Missing'), 'Fallback channel', num('0'), 'No secondary route configured.'],
        ],
      },
      actionPlan([
        ['Run the meeting adapter against the customer Gong instance', 'Platform', 'Before go-live'],
        ['Configure email as the fallback delivery channel', 'Solutions', 'Before go-live'],
        ['Re-score and confirm the green threshold', 'Solutions', 'After fixes'],
      ]),
      {
        kind: 'note',
        heading: '🚦 Verdict',
        body:
          'AMBER — do not go live. Both blocking items are hours of work, not days: one adapter test run and one fallback route configuration. Re-score after the fixes; the projected score is 92 (GREEN).',
      },
    ],
    evidence: [
      ['Connector status', 'OAuth grants and scope verification per system.', 'Updated 3h ago'],
      ['Identity layer', 'Owner-to-delivery-target coverage.', 'This run'],
      ['QA log', 'Which adapters have been exercised on this stack.', 'Jul 15'],
    ],
    banner: '🚩 Score 78 (AMBER) · 2 blockers identified · Go-live held pending fixes',
  },
}
