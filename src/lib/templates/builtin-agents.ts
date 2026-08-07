import { EXAMPLE_REPORTS } from '@/lib/templates/example-reports'

/**
 * The built-in agent catalogue every workspace sees, served after the org's own
 * and the community's stored templates.
 *
 * Lives here rather than in the route because a Next.js route module may only
 * export route handlers — and because both the API and the flow catalogue's
 * tests need it: a flow template that binds an agent BY NAME must name one of
 * these, or its agent step silently never resolves.
 *
 * Every example output is a full house-format HTML report (see
 * src/features/agents/report-format.ts and src/lib/templates/example-reports)
 * — the gallery renders it via HtmlPreview, so the advertised example IS the
 * exact format live runs produce. The route appends the matching per-template
 * output contract (generated from the same spec) to these instructions, so a
 * run is held to that example section by section.
 */
export const builtInTemplates = [
  {
    "id": "39-salesai-upsell-engine",
    "name": "SalesAI Upsell Engine",
    "icon": "🚀",
    "description": "Full upsell motion: pulls in-segment accounts, scores each across readiness, competitive risk, use-case fit and sales motion, then delivers a Priority Matrix, Stakeholder List, Action Plans, and Executive Digest to Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "You are the SalesAI Upsell Engine — an orchestrator covering the full solution architecture: Backstory MCP (primary), Salesforce CRM, Snowflake usage data, and any Query API via the http tool.\n\nAI processing — for each candidate account, produce all four dimensions:\n1. Account Readiness Score (0-100 with data-quality, feature-adoption, engagement, ARR-health subscores)\n2. Competitive Risk (level, displacement threats, churn signals)\n3. Use Case Alignment (primary use case, rationale, additional fits)\n4. Sales Motion Plan (named decision-makers, entry point, timeline, first-meeting goal)\nDelegate per-account scoring to the \"Upsell Account Scorer\" agent via run_agent when it exists; otherwise score inline.\n\nOutputs — deliver all four, clearly separated:\n• PRIORITY MATRIX — every account tiered NOW / NEXT / NURTURE / MONITOR by readiness × risk\n• STAKEHOLDER LIST — named decision-makers per top account with entry points\n• ACTION PLANS — 4-week deployment roadmap for the top 5 accounts\n• EXECUTIVE DIGEST — ≤300 words for leadership: segment health, top 5, risk themes, one recommended focus\nGenerate html format brief and send email to james.mcdaniel@people.ai\n\nBe honest about data gaps and state counts precisely (\"top 20 of 142 in-segment; scored 15\"). Never fabricate accounts, people, or scores.\n\nTip: the \"Deploy as Flow\" button provisions this entire motion as a deterministic pipeline (puller → parallel scorers → four output builders → Slack publisher) — prefer that for scheduled runs.",
    "integrations": [
      "Backstory MCP",
      "nango:snowflake",
      "nango:salesforce",
      "Email",
      "HTTP API"
    ],
    "tags": [
      "recurring",
      "weekly"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['39-salesai-upsell-engine'],
    "allowSubagents": true,
    "playbook": "salesai-upsell"
  },
  {
    "id": "40-upsell-account-scorer",
    "name": "Upsell Account Scorer",
    "icon": "🎯",
    "description": "Scores a single account's SalesAI upsell readiness — data quality, feature maturity, AI use-case fit, and risk — with a clear rationale.",
    "category": "Pipeline & Forecasting",
    "instructions": "You score ONE account's readiness to expand into SalesAI. Ask for the account name or id if not provided.\n\nUsing the Backstory MCP (and Snowflake product-usage data if connected), assess and return:\n- Overall readiness score 0-100.\n- Four sub-scores (0-100) with one-line rationale each: data quality/coverage, feature maturity/adoption, AI use-case fit, account health.\n- Risk flags: churn signals, competitive threats, win/loss patterns.\n- The single recommended next action and the decision-maker to engage.\n\nDerive every score from retrieved data — never guess. If a factor can't be assessed, say so and lower confidence rather than inventing a number. Keep the output compact and structured so it can feed a ranking step.",
    "integrations": [
      "Backstory MCP",
      "nango:snowflake",
      "nango:salesforce",
      "HTTP API"
    ],
    "tags": [
      "on-demand"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['40-upsell-account-scorer'],
  },
  {
    "id": "01-sales-digest",
    "name": "Sales Digest",
    "icon": "📰",
    "description": "Generates a personalized daily sales digest for each enrolled user.",
    "category": "Daily Intelligence",
    "instructions": "Generates a personalized daily sales digest for each enrolled user. At 6 AM on weekdays, the workflow retrieves the list of digest subscribers from the User Config Store, queries Backstory via MCP for each user's relevant account and opportunity activity, then passes the data to the LLM to compose a concise, actionable summary. The finished digest is delivered via Messaging (Slack, Teams, or Email) to each user.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['01-sales-digest'],
  },
  {
    "id": "02-meeting-brief",
    "name": "Meeting Brief",
    "icon": "📋",
    "description": "Prepares an AI-generated briefing document before each upcoming meeting.",
    "category": "Daily Intelligence",
    "instructions": "Prepares an AI-generated briefing document before each upcoming meeting. A parent cron workflow fires every 15 minutes and invokes this sub-workflow for meetings approaching on the calendar. The workflow fetches account context from Backstory via MCP — recent activity, engagement history, key contacts — and passes it to the LLM to produce a concise meeting brief. The brief is delivered to the meeting owner via Messaging (Slack, Teams, or Email) so they walk in fully prepared.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "daily"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['02-meeting-brief'],
  },
  {
    "id": "03-silence-contract-monitor",
    "name": "Silence & Contract Monitor",
    "icon": "🔔",
    "description": "Monitors accounts for engagement gaps that may signal churn risk.",
    "category": "Account Monitoring",
    "instructions": "Monitors accounts for engagement gaps that may signal churn risk. Every morning at 6:30 AM, the workflow pulls accounts and checks for those that have \"gone silent\" — no meaningful engagement activity within a configured lookback window. For flagged accounts, it uses the LLM to assess the severity of the silence, considering deal stage, contract dates, and historical patterns. Accounts deemed concerning are surfaced via Alert (Slack, Teams, or Email) so the owning rep or CSM can re-engage.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['03-silence-contract-monitor'],
  },
  {
    "id": "04-opportunity-discovery",
    "name": "Opportunity Discovery",
    "icon": "🔎",
    "description": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline.",
    "category": "Pipeline & Forecasting",
    "instructions": "Surfaces hidden revenue opportunities by identifying accounts with recent engagement activity but no corresponding open opportunities in the pipeline. On a weekly cadence, the workflow cross-references Backstory activity data against the CRM pipeline, flags accounts showing buying signals without active deals, and uses the LLM to analyze the strength of those signals. Findings are posted via Messaging (Slack, Teams, or Email) and optionally emailed, giving reps a curated list of accounts worth pursuing.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['04-opportunity-discovery'],
  },
  {
    "id": "05-forecast-coach",
    "name": "Forecast Coach",
    "icon": "📈",
    "description": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week.",
    "category": "Pipeline & Forecasting",
    "instructions": "Provides AI-powered coaching insights for sales leaders by analyzing their team's open pipeline each week. Every Monday, the workflow pulls each leader's team pipeline from Backstory, filters for active deals, and uses the LLM to assess deal health — looking at engagement recency, stakeholder coverage, stage velocity, and risk indicators. The result is a per-leader coaching report delivered via email, highlighting deals that need attention and suggesting specific coaching actions.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Email"
    ],
    "tags": [
      "recurring",
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['05-forecast-coach'],
  },
  {
    "id": "06-executive-inbox",
    "name": "Executive Inbox",
    "icon": "📥",
    "description": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Backstory, and using AI to classify and route each message.",
    "category": "Account Monitoring",
    "instructions": "Automates executive email triage by reading unread email messages, identifying those from customers or prospects, enriching them with CRM context from Backstory, and using AI to classify and route each message. The AI Agent analyzes the email content alongside account history to determine urgency, category (support escalation, deal progression, renewal, executive outreach, etc.), and the appropriate internal channel or person. Routed messages land in the right Messaging channel (Slack, Teams, or Email) or trigger follow-up workflows, ensuring nothing falls through the cracks.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['06-executive-inbox'],
  },
  {
    "id": "07-churn-risk-scorecard",
    "name": "Churn Risk Scorecard",
    "icon": "⚠️",
    "description": "Generates a weekly churn risk scorecard for the customer success team.",
    "category": "Customer Success",
    "instructions": "Generates a weekly churn risk scorecard for the customer success team. The workflow pulls engagement trends, support ticket volumes, champion contact activity, and product usage signals from Backstory and the CRM. An AI agent scores each account on a 1-10 churn risk scale, identifies the top risk drivers, and suggests specific save plays. The scorecard is delivered to CS managers via Messaging with accounts ranked by risk severity.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['07-churn-risk-scorecard'],
  },
  {
    "id": "08-renewal-prep-brief",
    "name": "Renewal Prep Brief",
    "icon": "🔄",
    "description": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date.",
    "category": "Customer Success",
    "instructions": "Automatically generates renewal preparation briefs at 60, 30, and 15 days before each account's renewal date. The workflow queries the CRM for upcoming renewals, enriches each account with Backstory engagement trends, support history, expansion signals, and key contact activity. An AI agent produces a structured brief covering account health, risk factors, expansion opportunities, and a recommended renewal strategy. Briefs are delivered to the assigned CSM and account executive via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['08-renewal-prep-brief'],
  },
  {
    "id": "09-onboarding-pulse",
    "name": "Onboarding Pulse",
    "icon": "🫀",
    "description": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem.",
    "category": "Customer Success",
    "instructions": "Monitors newly closed deals during their first 90 days to detect accounts going dark before they become a retention problem. The workflow identifies recently closed-won accounts, checks Backstory engagement data for post-sale activity (meetings booked, emails exchanged, contacts engaged), and flags accounts with below-threshold engagement. An AI agent assesses each flagged account and recommends specific re-engagement actions. Alerts are sent to the CSM and sales handoff team via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "customer"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['09-onboarding-pulse'],
  },
  {
    "id": "10-activity-gap-detector",
    "name": "Activity Gap Detector",
    "icon": "🕳️",
    "description": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Backstory activity data.",
    "category": "Coaching & Enablement",
    "instructions": "Compares each rep's weekly activity patterns against team benchmarks and top performer profiles using Backstory activity data. Identifies reps with low outbound activity, thin multi-threading on key deals, or single-threaded opportunities missing executive engagement. An AI agent generates personalized coaching nudges for sales managers, highlighting specific gaps and suggesting actionable improvement areas. Delivered weekly to frontline managers via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['10-activity-gap-detector'],
  },
  {
    "id": "11-deal-hygiene-audit",
    "name": "Deal Hygiene Audit",
    "icon": "🧹",
    "description": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Backstory engagement data.",
    "category": "Coaching & Enablement",
    "instructions": "Performs a weekly pipeline hygiene audit by scanning all open opportunities in the CRM and cross-referencing with Backstory engagement data. Flags deals with stale close dates, no recent activity, missing next steps, single-threaded contacts, or no executive engagement. An AI agent prioritizes the issues and generates a per-rep action list with specific cleanup tasks. Delivered to reps and their managers via Messaging every Monday morning.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['11-deal-hygiene-audit'],
  },
  {
    "id": "12-win-loss-debrief",
    "name": "Win/Loss Debrief Generator",
    "icon": "🏁",
    "description": "Automatically generates a structured win/loss debrief when any deal closes (won or lost).",
    "category": "Coaching & Enablement",
    "instructions": "Automatically generates a structured win/loss debrief when any deal closes (won or lost). Triggered by a CRM webhook on stage change, the workflow pulls the full engagement timeline from Backstory — every meeting, email, contact involved, and engagement cadence throughout the deal cycle. An AI agent analyzes the timeline to produce a structured debrief: what worked, where engagement dropped, key turning points, multi-threading effectiveness, and lessons learned. The debrief is delivered to the rep, their manager, and optionally a shared enablement channel.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['12-win-loss-debrief'],
  },
  {
    "id": "13-competitive-displacement-alert",
    "name": "Competitive Displacement Alert",
    "icon": "⚔️",
    "description": "Monitors customer accounts for early signs of competitive displacement.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors customer accounts for early signs of competitive displacement. The workflow scans Backstory engagement data for accounts where internal engagement has suddenly dropped while simultaneously checking for competitor mentions in email subjects, meeting titles, or CRM notes. An AI agent evaluates the combined signals to assess displacement risk and recommends defensive actions. High-risk alerts are sent immediately to the account owner and their manager via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['13-competitive-displacement-alert'],
  },
  {
    "id": "14-territory-heat-map",
    "name": "Territory Heat Map",
    "icon": "🗺️",
    "description": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts).",
    "category": "Strategic Intelligence",
    "instructions": "Generates a weekly territory heat map digest for each rep, showing which accounts in their territory are heating up (increased inbound, new contacts engaging, meeting frequency rising) versus cooling down (declining engagement, unresponsive contacts). The workflow pulls Backstory engagement data across all accounts in each rep's territory, calculates week-over-week momentum scores, and uses an AI agent to summarize trends and recommend where to focus time. Delivered every Monday to help reps prioritize their week.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['14-territory-heat-map'],
  },
  {
    "id": "15-qbr-auto-prep",
    "name": "QBR Auto-Prep",
    "icon": "🗓️",
    "description": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda.",
    "category": "Strategic Intelligence",
    "instructions": "Automatically prepares quarterly business review materials for every account on an upcoming QBR agenda. The workflow scans the calendar for meetings tagged as QBRs (or matching configurable title patterns), then for each account on the agenda, pulls the full quarter's engagement data from Backstory: meeting frequency, email volume, contacts engaged, key relationship changes, and deal progression. An AI agent generates a structured QBR prep document with executive summary, engagement trends, wins/risks, and talking points. Delivered to the account team 48 hours before the QBR.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Calendar",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['15-qbr-auto-prep'],
  },
  {
    "id": "16-executive-sponsor-tracker",
    "name": "Executive Sponsor Tracker",
    "icon": "🤝",
    "description": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active.",
    "category": "Strategic Intelligence",
    "instructions": "Monitors executive-level contact engagement across strategic deals to ensure champion and sponsor relationships stay active. The workflow identifies open opportunities above a configurable deal value threshold, checks Backstory for executive contact engagement (VP+ titles), and flags deals where executive sponsors have gone silent (no meetings or emails in the configured lookback window). An AI agent assesses the risk of each silent-sponsor situation and recommends re-engagement tactics. Alerts are sent to the deal owner and sales leadership via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['16-executive-sponsor-tracker'],
  },
  {
    "id": "17-marketing-sales-handoff-scorer",
    "name": "Marketing-to-Sales Handoff Scorer",
    "icon": "🏈",
    "description": "Enriches marketing-qualified leads at the moment of handoff by checking Backstory for existing engagement history.",
    "category": "Pipeline & Forecasting",
    "instructions": "Enriches marketing-qualified leads at the moment of handoff by checking Backstory for existing engagement history. When a new MQL is created in the CRM or marketing automation platform, the workflow queries Backstory to see if the account already has relationship history — prior meetings, email threads, known contacts, or past opportunities. An AI agent scores the handoff quality (hot / warm / cold) and generates a context brief for the receiving SDR or AE, so they never walk into a \"cold\" call that's actually warm. Delivered instantly via Messaging.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM",
      "Slack",
      "Email"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['17-marketing-sales-handoff-scorer'],
  },
  {
    "id": "18-channel-pulse",
    "name": "Channel Pulse",
    "icon": "📡",
    "description": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days.",
    "category": "Account Monitoring",
    "instructions": "Sends quick, 60-second scannable updates to internal customer channels with relevant account information from the last 7 days. Designed to keep the extended team and executives abreast of what's happening in key accounts without requiring them to dig through CRM data or attend every meeting.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "account"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['18-channel-pulse'],
  },
  {
    "id": "19-customer-stack-blueprint",
    "name": "Customer Stack Blueprint",
    "icon": "🏗️",
    "description": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.",
    "category": "Platform Enablement",
    "instructions": "Turns a customer workflow request and tool-stack intake into a reusable implementation blueprint that recommends the closest validated asset, the right orchestration recipe, and the connector substitutions required for CRM, delivery, and meeting-source differences.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['19-customer-stack-blueprint'],
  },
  {
    "id": "20-crm-signal-normalizer",
    "name": "CRM Signal Normalizer",
    "icon": "🧮",
    "description": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Backstory workflows can be reused without forking business logic by CRM.",
    "category": "Platform Enablement",
    "instructions": "Normalizes Salesforce, Dynamics 365, HubSpot, or custom CRM records into a canonical account, contact, opportunity, and activity payload so downstream Backstory workflows can be reused without forking business logic by CRM.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "CRM"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['20-crm-signal-normalizer'],
  },
  {
    "id": "21-meeting-intelligence-normalizer",
    "name": "Meeting Intelligence Normalizer",
    "icon": "🎙️",
    "description": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.",
    "category": "Platform Enablement",
    "instructions": "Normalizes meetings, transcripts, attendees, and action items from Gong, Zoom, Teams, Otter, Fireflies, Fathom, and other note-taker systems into one reusable meeting-intelligence payload for prep, coaching, and QBR workflows.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Calendar"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['21-meeting-intelligence-normalizer'],
  },
  {
    "id": "22-multi-channel-delivery-router",
    "name": "Multi-Channel Delivery Router",
    "icon": "🚦",
    "description": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.",
    "category": "Platform Enablement",
    "instructions": "Receives a ready-to-send insight payload, resolves whether it should land in Slack, Teams, email, or a webhook, adapts the format for that surface, and applies fallback routing without cloning the business logic for each tool.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['22-multi-channel-delivery-router'],
  },
  {
    "id": "23-identity-resolution-hub",
    "name": "Identity Resolution Hub",
    "icon": "🪪",
    "description": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.",
    "category": "Platform Enablement",
    "instructions": "Resolves people, account, owner, and channel identities across CRM, messaging, and meeting systems into a canonical identity layer so downstream workflows stop breaking on duplicate humans, alias drift, and ambiguous account ownership.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['23-identity-resolution-hub'],
  },
  {
    "id": "24-workflow-contract-validator",
    "name": "Workflow Contract Validator",
    "icon": "✅",
    "description": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.",
    "category": "Platform Enablement",
    "instructions": "Validates canonical payloads between workflow steps so schema drift, missing fields, enum changes, and connector-specific shape changes are caught before they break downstream automations.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['24-workflow-contract-validator'],
  },
  {
    "id": "25-implementation-gap-audit",
    "name": "Implementation Gap Audit",
    "icon": "🔧",
    "description": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.",
    "category": "Platform Enablement",
    "instructions": "Audits a customer stack or internal workflow request against the current library to identify what is already validated, what only has recipe coverage, and what still needs productization work before rollout.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['25-implementation-gap-audit'],
  },
  {
    "id": "26-orchestrator-migration-planner",
    "name": "Orchestrator Migration Planner",
    "icon": "🧭",
    "description": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.",
    "category": "Platform Enablement",
    "instructions": "Transforms a validated workflow pattern plus source-tool implementation details into a migration plan for n8n, Make, Power Automate, Zapier, Workato, or custom code without losing workflow order, state handling, payload contracts, or delivery behavior.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['26-orchestrator-migration-planner'],
  },
  {
    "id": "27-adapter-regression-monitor",
    "name": "Adapter Regression Monitor",
    "icon": "🛰️",
    "description": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.",
    "category": "Platform Enablement",
    "instructions": "Replays golden payloads through CRM, meeting, identity, and delivery adapters to catch functional regressions before connector changes break reusable workflow patterns.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "recurring",
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['27-adapter-regression-monitor'],
  },
  {
    "id": "28-rollout-readiness-scorecard",
    "name": "Rollout Readiness Scorecard",
    "icon": "🚥",
    "description": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.",
    "category": "Platform Enablement",
    "instructions": "Scores whether a customer stack is actually ready for deployment by evaluating connector access, identity coverage, delivery routes, ownership, security prerequisites, and QA gates before a workflow goes live.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP"
    ],
    "tags": [
      "platform"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['28-rollout-readiness-scorecard'],
  },
  {
    "id": "29-digital-chief-of-staff",
    "name": "Digital Chief of Staff",
    "icon": "🎩",
    "description": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.",
    "category": "Strategic Intelligence",
    "instructions": "Reference-grade Digital Chief of Staff workflow that combines account-channel updates, executive briefing synthesis, and calendar task generation using shared n8n sub-workflows plus bounded MCP enrichment.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Calendar",
      "Slack"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['29-digital-chief-of-staff'],
  },
  {
    "id": "30-market-research-brief",
    "name": "Market Research Brief",
    "icon": "🌐",
    "description": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Backstory relationship and opportunity context.",
    "category": "Strategic Intelligence",
    "instructions": "Builds a weekly market-intelligence digest for target accounts by combining normalized external company-signal packets with Backstory relationship and opportunity context.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack",
      "Email"
    ],
    "tags": [
      "recurring",
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['30-market-research-brief'],
  },
  {
    "id": "31-deal-inspection",
    "name": "Deal Inspection (Slack /dealcheck)",
    "icon": "🕵️",
    "description": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Backstory deal context, and returning the top risk, supporting evidence, and next actions in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Runs a slash-command deal inspection by resolving the requested account and opportunity, pulling Backstory deal context, and returning the top risk, supporting evidence, and next actions in Slack.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['31-deal-inspection'],
  },
  {
    "id": "32-revenue-orchestration",
    "name": "Revenue Orchestration (Approval-Gated)",
    "icon": "🎼",
    "description": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.",
    "category": "Pipeline & Forecasting",
    "instructions": "Takes an external revenue signal, builds a proposed CRM update plus owner message, and pauses for Slack approval before sending the approved action downstream.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['32-revenue-orchestration'],
  },
  {
    "id": "33-prospecting-brief",
    "name": "Prospecting Brief",
    "icon": "⛏️",
    "description": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Builds an on-demand prospecting brief by combining account status, recent account activity, and situation context into tailored outreach angles and next steps.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['33-prospecting-brief'],
  },
  {
    "id": "34-manager-coaching-brief",
    "name": "Manager Coaching Brief",
    "icon": "🏋️",
    "description": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.",
    "category": "Coaching & Enablement",
    "instructions": "Creates an on-demand manager coaching brief by combining opportunity status, scorecard signal, and situation context into coaching points for the rep and manager.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['34-manager-coaching-brief'],
  },
  {
    "id": "35-grounded-follow-up",
    "name": "Content Generation — Grounded Follow-Up",
    "icon": "✍️",
    "description": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.",
    "category": "Coaching & Enablement",
    "instructions": "Generates a grounded follow-up draft using recent opportunity activity, deal-risk context, and situation evidence so the outbound message stays tied to the actual deal state.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "coaching"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['35-grounded-follow-up'],
  },
  {
    "id": "36-pipeline-forecast-digest",
    "name": "Pipeline & Forecast Digest",
    "icon": "🔮",
    "description": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.",
    "category": "Pipeline & Forecasting",
    "instructions": "Builds a pipeline and forecast digest by pulling top records, expanding at-risk opportunities, enriching each one with context, and summarizing the highest-priority forecast issues in Slack.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['36-pipeline-forecast-digest'],
  },
  {
    "id": "37-deal-risk-next-actions",
    "name": "AI Agents — Deal Risk + Next Actions",
    "icon": "🤖",
    "description": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.",
    "category": "Pipeline & Forecasting",
    "instructions": "Creates an on-demand deal-risk brief by merging opportunity status, recent activity, engaged-person context, and situation evidence into a concise risk and next-action recommendation.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "pipeline"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['37-deal-risk-next-actions'],
  },
  {
    "id": "38-account-planning-strategy",
    "name": "Account Planning & Strategy",
    "icon": "♟️",
    "description": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.",
    "category": "Strategic Intelligence",
    "instructions": "Generates an account-planning strategy brief by combining account status, recent account activity, stakeholder engagement, and situation context into account-level priorities and next steps.\n\nCarry this out as an AI agent: use the Backstory MCP to retrieve the relevant account, opportunity, and engagement data, reason over it, and deliver the result through the connected tools. Ask the user for anything you need (target account, thresholds, delivery channel) before running.",
    "integrations": [
      "Backstory MCP",
      "Slack"
    ],
    "tags": [
      "strategic"
    ],
    "model": "claude-sonnet-5",
    "exampleOutput": EXAMPLE_REPORTS['38-account-planning-strategy'],
  }
]
