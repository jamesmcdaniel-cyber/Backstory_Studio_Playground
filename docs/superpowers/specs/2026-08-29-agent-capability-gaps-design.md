# Agent capability gaps — making the built-in templates executable

Date: 2026-08-29

## Why

`src/lib/templates/builtin-agents.ts` ships 40 built-in agent templates. Nine of
them describe capabilities the runtime **cannot actually perform**. Deploying
one produces an agent whose instructions promise a motion no tool in its plane
can carry out, so the model either improvises or asks the user to do it by hand.
That is the worst failure mode a template catalogue has: the gallery advertises
the example output, and the live run cannot reach it.

The gaps, and what each template claims:

| Template | Claimed capability | Reality before this work |
|---|---|---|
| 01 Sales Digest | "retrieves the list of digest subscribers from the User Config Store" | Data Tables exist and are durable + tenant-scoped, but an agent has **no tool to create one**. It can read and write rows in a table a human made; it cannot provision its own roster. |
| 02 Meeting Brief | "meetings approaching on the calendar" | **No calendar plane exists at all.** Not a Nango provider, not a native connector. |
| 06 Executive Inbox | "reading unread email messages" | ✅ Already works — `gmail_list_messages` / `gmail_read_message` are wired (`GMAIL_READ_TOOLS`). The template just never *attached* Gmail. |
| 15 QBR Auto-Prep | "scans the calendar for meetings tagged as QBRs" | No calendar plane. |
| 27 Adapter Regression Monitor | "replays golden payloads through CRM, meeting, identity, and delivery adapters" | No golden fixtures, and no way to execute an adapter without a live connection. `src/lib/eval` is a *model* eval harness, not a connector one. |
| 29 Digital Chief of Staff | "shared sub-workflows plus calendar task generation" | ✅ Sub-workflows work (`run_flow`). ✗ Calendar task creation. |
| 30 Market Research Brief | "normalized external company-signal packets" | Only the generic `request` HTTP tool, which needs a URL the model already knows. **No search.** |
| 31 Deal Inspection | "`/dealcheck` slash command" | Slack Events API is wired (mentions, app install), but **slash commands are a different Slack surface** with a different payload, a 3-second budget and a `response_url`. No route handles them. |
| 32 Revenue Orchestration | "pauses for Slack approval before sending the approved action downstream" | ✅ Already works — `requiresApproval` gates every `nango:*` write, `decideApproval` executes it. The template never attached Salesforce, so there was no CRM write to gate. |

So three of the nine were **already capable and merely unattached** — the fix
there is the `integrations` array, not new code. Six need real capability.

## Scope decision

The request said "outside of integrations that are supposed to handle some of
these". Read as: *don't rebuild what the integration substrate already covers;
use it.* Every new external capability here is therefore added **inside the
existing substrate** — a Nango provider entry, a native connector descriptor, a
workspace-owned credential — not as a parallel mechanism. Adding a provider to
`src/lib/nango/provider-tools.ts` propagates automatically to the plane loader,
the approval gate, the flow tool catalogue and the integrations capability
dialog, because all four derive from that one registry.

## Workstreams

**WS1 — Calendar plane.** Google Calendar as a Nango provider: list/get events,
create/update events. `create_event` is a write, so it inherits the approval
gate for free. Unblocks 02, 15, 29.

**WS2 — Durable config/subscriber store.** `data_table_create_table` and
`data_table_describe_table`, so an agent can provision the roster it is told to
read. Deliberately *not* a new key-value model: Data Tables are already durable,
typed, RLS-scoped, and have a human-editable UI — which is exactly what a
subscriber list needs, since a human has to be able to add subscribers.
Unblocks 01.

**WS3 — Slack slash commands.** `/api/slack/commands`, signature-verified,
routed by `team_id`, with a `SlackCommandBinding` (org, command → agent). Acks
inside Slack's 3s budget and delivers the run's answer to `response_url`.
Identity: the invoking Slack user must be linked (`SlackIdentity`) — fail closed,
same ruling as mentions. Unblocks 31.

**WS4 — Research plane.** `web_search` + `web_fetch`, backed by a
workspace-owned Brave Search key (the `CREDENTIAL_PROVIDERS` pattern), with
`web_fetch` going through `fetchPublicUrl` so it inherits SSRF protection.
Unblocks 30.

**WS5 — Adapter golden fixtures.** Recorded request/response goldens per
adapter plus a pure replay that runs them offline, exposed both as a CI test and
as a `replay_adapter_fixtures` agent tool. Unblocks 27.

**WS6 — Attach the planes.** Update the `integrations` arrays of the nine
templates so deploying one actually attaches what its instructions describe —
including the three that were already capable.

## Invariants to preserve

- Write tools stay `isWrite: true` so the approval gate and audit trail cover
  them. `google_calendar_create_event` writing to someone's calendar is exactly
  the class of action `requireApproval` exists for.
- The slash-command route must never become a `team_id` oracle: every
  org-scoped failure returns the same ack, per the Events route's ruling.
- No raw token syntax in any user-facing string.
