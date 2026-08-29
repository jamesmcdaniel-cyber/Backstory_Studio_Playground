/**
 * Golden fixtures for the connector adapters.
 *
 * The Adapter Regression Monitor template describes "replaying golden payloads
 * through CRM, meeting, identity, and delivery adapters". Nothing here could
 * do that: the adapters were only ever exercised against a live connection,
 * and src/lib/eval is a MODEL eval harness, not a connector one.
 *
 * What the adapters actually are, and therefore what a golden pins:
 *
 *  - A `request` adapter turns tool arguments into an upstream call. The golden
 *    is the emitted request — method, endpoint, params, body. This is where
 *    connector regressions live: a renamed parameter, a bumped API version, a
 *    path segment that stopped being URL-encoded. Each one is silent at the
 *    type level and only shows up as a failed run against a real account.
 *  - A `transform` adapter maps an upstream payload into our own shape. The
 *    golden is the output for a recorded input.
 *
 * Both replay offline, with no credential and no network, which is the point:
 * a regression should be catchable in CI on a machine that has never been
 * connected to Salesforce.
 *
 * Fixtures are deliberately written as VALUES rather than generated from the
 * specs. A golden derived from the code it checks cannot catch the code
 * changing — it would just move with it.
 */

import type { NangoProxyArgs } from '@/lib/nango/delivery'

/** The adapter families the monitor reports on, in the template's own terms. */
export const ADAPTER_FAMILIES = ['crm', 'meeting', 'identity', 'delivery', 'calendar', 'research'] as const
export type AdapterFamily = (typeof ADAPTER_FAMILIES)[number]

export interface RequestFixture {
  kind: 'request'
  id: string
  family: AdapterFamily
  /** Why this fixture exists — shown in the drift report, so a failure explains itself. */
  pins: string
  tool: string
  args: Record<string, unknown>
  expect: Omit<NangoProxyArgs, 'connectionId' | 'providerConfigKey'>
}

export interface TransformFixture {
  kind: 'transform'
  id: string
  family: AdapterFamily
  pins: string
  /** Key into TRANSFORM_ADAPTERS — the pure function under test. */
  transform: string
  input: unknown
  expect: unknown
}

export type AdapterFixture = RequestFixture | TransformFixture

export const ADAPTER_FIXTURES: AdapterFixture[] = [
  // ── CRM ────────────────────────────────────────────────────────────────────
  {
    kind: 'request',
    id: 'crm/salesforce-query',
    family: 'crm',
    pins: 'SOQL travels as the `q` query parameter on the versioned query endpoint.',
    tool: 'salesforce_query',
    args: { soql: 'SELECT Id, Name FROM Account LIMIT 10' },
    expect: {
      method: 'GET',
      endpoint: '/services/data/v60.0/query',
      params: { q: 'SELECT Id, Name FROM Account LIMIT 10' },
    },
  },
  {
    kind: 'request',
    id: 'crm/salesforce-update-encodes-path',
    family: 'crm',
    pins: 'Object and record id are URL-encoded path segments — a model-supplied id cannot traverse to another resource.',
    tool: 'salesforce_update_record',
    args: { sobject: 'Opportunity', id: '006/../Account/001', fields: { StageName: 'Closed Won' } },
    expect: {
      method: 'PATCH',
      endpoint: '/services/data/v60.0/sobjects/Opportunity/006%2F..%2FAccount%2F001',
      data: { StageName: 'Closed Won' },
    },
  },
  {
    kind: 'request',
    id: 'crm/hubspot-update-deal',
    family: 'crm',
    pins: 'A HubSpot property update is a PATCH with the values nested under `properties`.',
    tool: 'hubspot_update_deal',
    args: { dealId: '12345', properties: { dealstage: 'contractsent' } },
    expect: {
      method: 'PATCH',
      endpoint: '/crm/v3/objects/deals/12345',
      data: { properties: { dealstage: 'contractsent' } },
    },
  },

  // ── Meeting ────────────────────────────────────────────────────────────────
  {
    kind: 'request',
    id: 'meeting/granola-get-note-includes-transcript',
    family: 'meeting',
    pins: 'The note read asks for the transcript explicitly; without it a brief is built from the summary alone.',
    tool: 'granola_get_note',
    args: { note_id: 'not_abc' },
    expect: { method: 'GET', endpoint: '/v1/notes/not_abc', params: { include: 'transcript' } },
  },

  // ── Calendar ───────────────────────────────────────────────────────────────
  {
    kind: 'request',
    id: 'calendar/list-expands-recurrences',
    family: 'calendar',
    pins: 'singleEvents travels as a STRING; as a boolean it is dropped and every recurring meeting arrives unexpanded.',
    tool: 'google_calendar_list_events',
    args: { timeMin: '2026-09-01T00:00:00Z', timeMax: '2026-09-08T00:00:00Z' },
    expect: {
      method: 'GET',
      endpoint: '/calendar/v3/calendars/primary/events',
      params: {
        timeMin: '2026-09-01T00:00:00Z',
        timeMax: '2026-09-08T00:00:00Z',
        maxResults: 50,
        singleEvents: 'true',
        orderBy: 'startTime',
      },
    },
  },
  {
    kind: 'request',
    id: 'calendar/all-day-task-stays-all-day',
    family: 'calendar',
    pins: 'A bare date becomes `date`, not `dateTime` — under dateTime it is accepted and lands at midnight UTC.',
    tool: 'google_calendar_create_event',
    args: { summary: 'Renewal paperwork', start: '2026-09-01' },
    expect: {
      method: 'POST',
      endpoint: '/calendar/v3/calendars/primary/events',
      data: { summary: 'Renewal paperwork', start: { date: '2026-09-01' }, end: { date: '2026-09-01' } },
    },
  },

  // ── Delivery ───────────────────────────────────────────────────────────────
  {
    kind: 'request',
    id: 'delivery/slack-post-threads',
    family: 'delivery',
    pins: 'A reply carries thread_ts; losing it posts the answer to the channel instead of the conversation.',
    tool: 'slack_post_message',
    args: { channel: 'C123', text: 'Deal risk summary', thread_ts: '1712345678.000100' },
    expect: {
      method: 'POST',
      endpoint: '/chat.postMessage',
      data: { channel: 'C123', text: 'Deal risk summary', thread_ts: '1712345678.000100' },
    },
  },
  {
    kind: 'request',
    id: 'delivery/salesforce-create-record',
    family: 'delivery',
    pins: 'A created record posts its fields as the body, to the versioned sobject collection.',
    tool: 'salesforce_create_record',
    args: { sobject: 'Task', fields: { Subject: 'Follow up', Status: 'Open' } },
    expect: {
      method: 'POST',
      endpoint: '/services/data/v60.0/sobjects/Task',
      data: { Subject: 'Follow up', Status: 'Open' },
    },
  },

  // ── Identity ───────────────────────────────────────────────────────────────
  {
    kind: 'transform',
    id: 'identity/slack-message-identity',
    family: 'identity',
    pins: 'A message is identified by channel + ts, so a live delivery and a backfilled page dedupe to one row.',
    transform: 'normalizeSlackEvent',
    input: {
      event_id: 'Ev123',
      event_time: 1_764_547_200,
      event: { type: 'message', channel: 'C123', ts: '1764547200.000100', user: 'U999', text: 'hello' },
    },
    expect: { kind: 'message.posted', sourceEventId: 'slack:msg:C123:1764547200.000100', actorExternalId: 'U999', selfOrigin: false },
  },
  {
    kind: 'transform',
    id: 'identity/slack-self-origin',
    family: 'identity',
    pins: 'The bot recognising its OWN post is what terminates a reply loop.',
    transform: 'normalizeSlackEvent',
    input: {
      event_id: 'Ev124',
      event: { type: 'message', channel: 'C123', ts: '1764547300.000100', bot_id: 'B1', text: 'posted by the app' },
    },
    expect: { kind: 'message.posted', sourceEventId: 'slack:msg:C123:1764547300.000100', actorExternalId: 'B1', selfOrigin: true },
  },
  {
    kind: 'transform',
    id: 'identity/mention-longest-label-wins',
    family: 'identity',
    pins: '"Spend review" must not be shadowed by a teammate called "Spend".',
    transform: 'resolveMention',
    input: {
      text: '<@U_BOT> Spend review: what changed this week?',
      botUserId: 'U_BOT',
      agents: [
        { id: 'a1', name: 'Spend' },
        { id: 'a2', name: 'Spend review' },
      ],
    },
    expect: { kind: 'agent', agentId: 'a2', prompt: 'what changed this week?' },
  },

  // ── Research ───────────────────────────────────────────────────────────────
  {
    kind: 'transform',
    id: 'research/brave-results',
    family: 'research',
    pins: 'Match markup is stripped from snippets before the model quotes them.',
    transform: 'normalizeBraveResults',
    input: {
      web: {
        results: [
          { title: 'Acme raises', url: 'https://n.example/a', description: 'Closed a <strong>$40M</strong> round.' },
        ],
      },
    },
    expect: [{ title: 'Acme raises', url: 'https://n.example/a', snippet: 'Closed a $40M round.' }],
  },
]
