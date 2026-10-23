/**
 * Compensating actions — how (and whether) each write tool can be undone.
 *
 * ONE registry, next to the write tools it covers (provider-tools.ts and the
 * delivery adapters in delivery.ts), keyed by the bare tool name. Every Nango
 * write tool has an entry, undoable or not: compensators.test.ts fails when a
 * new write tool lands without one, so "can this be undone?" is a decision a
 * person made, never a silent default.
 *
 * Three shapes of undo, and only these:
 *   - created something  → delete (or archive/trash/close where the provider
 *                          offers nothing stronger — the `effect` says which);
 *   - posted a message   → delete it by its ts/id;
 *   - updated fields     → restore the prior values. That needs the record as
 *                          it was BEFORE the write, so `captureBefore` reads it
 *                          just ahead of the call. Only tools whose provider can
 *                          be read cheaply and written back faithfully get one;
 *                          the rest say plainly that they cannot be undone.
 *
 * `ref` extracts the provider's own reference to what a call created (message
 * ts, record id, URL) from its result — recorded on the ledger for every write,
 * undoable or not, so a person can find the thing the agent made.
 *
 * Undo runs through the SAME transport the write did (the Nango proxy with the
 * connection the write used; the workspace bot token for the native Slack
 * plane). Who may run it is decided by the undo service, not here.
 */

import { defaultProxy, slackData, type DeliveryConnection, type NangoProxy } from './delivery'

/** The provider's reference to what a write created or touched. */
export type ResultRef = {
  /** Record / message / item id as the provider names it. */
  id?: string
  /** Slack message timestamp. */
  ts?: string
  /** Slack channel id (as Slack returns it, even when a name was passed). */
  channel?: string
  /** A link a person can open. */
  url?: string
  /** Short human label, e.g. "#revenue" or "Task 00T5e…". */
  label?: string
  /** Extra coordinates an undo needs (sobject, owner/repo, base/table, range…). */
  [key: string]: string | string[] | undefined
}

export type UndoInput = {
  args: Record<string, unknown>
  ref: ResultRef
  /** Prior values captured by `captureBefore`, when the tool has one. */
  before: unknown
}

export type Compensation =
  | {
      undoable: true
      /** What Undo does, in plain words (shown on the ledger entry). */
      effect: string
      ref: (result: unknown, args: Record<string, unknown>) => ResultRef | null
      /** Read the prior values just before an update runs. */
      captureBefore?: (connection: DeliveryConnection, args: Record<string, unknown>, proxy?: NangoProxy) => Promise<unknown>
      /** Null when an undo can run; otherwise why it cannot for THIS entry. */
      missing?: (input: UndoInput) => string | null
      undo: (connection: DeliveryConnection, input: UndoInput, proxy?: NangoProxy) => Promise<unknown>
    }
  | {
      undoable: false
      /** Why not, in plain words. */
      reason: string
      ref?: (result: unknown, args: Record<string, unknown>) => ResultRef | null
    }

// ── helpers ──────────────────────────────────────────────────────────────────

const str = (value: unknown) => (value == null ? '' : String(value))
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const seg = (value: unknown) => encodeURIComponent(str(value))
/** Drop empty fields so a ref only carries what the provider actually returned. */
function clean(ref: ResultRef): ResultRef | null {
  const out: ResultRef = {}
  for (const [key, value] of Object.entries(ref)) {
    if (Array.isArray(value) ? value.length : value) out[key] = value
  }
  return Object.keys(out).length ? out : null
}
const call = (connection: DeliveryConnection, proxy: NangoProxy, request: Omit<Parameters<NangoProxy>[0], 'connectionId' | 'providerConfigKey'>) =>
  proxy({ ...request, connectionId: connection.connectionId, providerConfigKey: connection.providerConfigKey }).then((response) => response.data)
const needs = (input: UndoInput, ...keys: string[]) =>
  keys.every((key) => input.ref[key]) ? null : "The provider didn't return an id for what was created, so there is nothing to point an undo at."
const needsBefore = (input: UndoInput) =>
  record(input.before) && Object.keys(record(input.before)!).length
    ? null
    : "The earlier values couldn't be read before this change, so there is nothing to restore."

/** Field names an update touched — the only ones a before-image needs. */
const touchedKeys = (value: unknown) => Object.keys(record(value) ?? {}).filter((key) => key && key !== 'attributes').slice(0, 100)

// ── Slack ────────────────────────────────────────────────────────────────────

const slackMessageRef = (result: unknown, args: Record<string, unknown>) => {
  const data = record(result)
  return clean({ channel: str(data?.channel), ts: str(data?.ts), label: str(args.channel) || str(args.user) || undefined })
}

const slackDelete: Compensation = {
  undoable: true,
  effect: 'Deletes the message.',
  ref: slackMessageRef,
  missing: (input) => needs(input, 'channel', 'ts'),
  undo: async (connection, input, proxy = defaultProxy()) =>
    slackData(await call(connection, proxy, { method: 'POST', endpoint: '/chat.delete', data: { channel: input.ref.channel, ts: input.ref.ts } })),
}

// ── Salesforce ───────────────────────────────────────────────────────────────

const SF = '/services/data/v60.0/sobjects'

// ── Registry ─────────────────────────────────────────────────────────────────

export const NANGO_COMPENSATIONS: Record<string, Compensation> = {
  // Slack
  slack_post_message: slackDelete,
  slack_send_direct_message: slackDelete,
  slack_add_reaction: {
    undoable: true,
    effect: 'Removes the reaction.',
    ref: (_result, args) => clean({ channel: str(args.channel), ts: str(args.timestamp), name: str(args.name).replace(/:/g, '') }),
    missing: (input) => needs(input, 'channel', 'ts', 'name'),
    undo: async (connection, input, proxy = defaultProxy()) =>
      slackData(await call(connection, proxy, { method: 'POST', endpoint: '/reactions.remove', data: { channel: input.ref.channel, timestamp: input.ref.ts, name: input.ref.name } })),
  },

  // Gmail
  gmail_send_email: {
    undoable: false,
    reason: "Sent email can't be recalled — it is already in the recipient's inbox.",
    ref: (result) => clean({ id: str(record(result)?.id), threadId: str(record(result)?.threadId) }),
  },

  // Salesforce
  salesforce_create_record: {
    undoable: true,
    effect: 'Deletes the record (it goes to the Salesforce recycle bin).',
    ref: (result, args) => clean({ id: str(record(result)?.id), sobject: str(args.sobject), label: str(args.sobject) || undefined }),
    missing: (input) => needs(input, 'id', 'sobject'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `${SF}/${seg(input.ref.sobject)}/${seg(input.ref.id)}` }),
  },
  salesforce_update_record: {
    undoable: true,
    effect: 'Puts the changed fields back to their earlier values.',
    ref: (_result, args) => clean({ id: str(args.id), sobject: str(args.sobject), label: str(args.sobject) || undefined }),
    captureBefore: async (connection, args, proxy = defaultProxy()) => {
      const fields = touchedKeys(args.fields)
      if (!fields.length) return null
      const current = record(await call(connection, proxy, { method: 'GET', endpoint: `${SF}/${seg(args.sobject)}/${seg(args.id)}`, params: { fields: fields.join(',') } }))
      return current ? Object.fromEntries(fields.map((field) => [field, current[field] ?? null])) : null
    },
    missing: (input) => needs(input, 'id', 'sobject') ?? needsBefore(input),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `${SF}/${seg(input.ref.sobject)}/${seg(input.ref.id)}`, data: input.before }),
  },

  // HubSpot
  hubspot_create_contact: {
    undoable: true,
    effect: 'Archives the contact (HubSpot keeps it restorable for 90 days).',
    ref: (result) => clean({ id: str(record(result)?.id) }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/crm/v3/objects/contacts/${seg(input.ref.id)}` }),
  },
  hubspot_update_deal: {
    undoable: true,
    effect: 'Puts the changed deal properties back to their earlier values.',
    ref: (_result, args) => clean({ id: str(args.dealId) }),
    captureBefore: async (connection, args, proxy = defaultProxy()) => {
      const properties = touchedKeys(args.properties)
      if (!properties.length) return null
      const current = record(record(await call(connection, proxy, { method: 'GET', endpoint: `/crm/v3/objects/deals/${seg(args.dealId)}`, params: { properties: properties.join(',') } }))?.properties)
      // HubSpot clears a property with an empty string, and reports an unset one as null.
      return current ? Object.fromEntries(properties.map((name) => [name, current[name] ?? ''])) : null
    },
    missing: (input) => needs(input, 'id') ?? needsBefore(input),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `/crm/v3/objects/deals/${seg(input.ref.id)}`, data: { properties: input.before } }),
  },

  // GitHub
  github_create_issue: {
    undoable: true,
    effect: "Closes the issue as not planned — GitHub doesn't let apps delete issues.",
    ref: (result, args) => {
      const data = record(result)
      return clean({ id: str(data?.number), url: str(data?.html_url), owner: str(args.owner), repo: str(args.repo), label: data?.number ? `#${str(data.number)}` : undefined })
    },
    missing: (input) => needs(input, 'id', 'owner', 'repo'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `/repos/${seg(input.ref.owner)}/${seg(input.ref.repo)}/issues/${seg(input.ref.id)}`, data: { state: 'closed', state_reason: 'not_planned' } }),
  },
  github_comment: {
    undoable: true,
    effect: 'Deletes the comment.',
    ref: (result, args) => clean({ id: str(record(result)?.id), url: str(record(result)?.html_url), owner: str(args.owner), repo: str(args.repo) }),
    missing: (input) => needs(input, 'id', 'owner', 'repo'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/repos/${seg(input.ref.owner)}/${seg(input.ref.repo)}/issues/comments/${seg(input.ref.id)}` }),
  },

  // Linear
  linear_create_issue: {
    undoable: true,
    effect: 'Deletes the issue (Linear moves it to the trash).',
    ref: (result) => {
      const issue = record(record(record(record(result)?.data)?.issueCreate)?.issue)
      return clean({ id: str(issue?.id), url: str(issue?.url), label: str(issue?.identifier) || undefined })
    },
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'POST', endpoint: '/graphql', data: { query: 'mutation Delete($id: String!) { issueDelete(id: $id) { success } }', variables: { id: input.ref.id } } }),
  },
  linear_update_issue: {
    undoable: false,
    reason: "Backstory doesn't read the issue before changing it, so there are no earlier values to restore.",
    ref: (_result, args) => clean({ id: str(args.id) }),
  },

  // Jira
  jira_create_issue: {
    undoable: true,
    effect: 'Deletes the issue.',
    ref: (result) => clean({ id: str(record(result)?.key) || str(record(result)?.id), label: str(record(result)?.key) || undefined }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/rest/api/3/issue/${seg(input.ref.id)}` }),
  },
  jira_update_issue: {
    undoable: false,
    reason: "Jira fields don't round-trip safely (status and people fields need their own calls), so earlier values aren't captured.",
    ref: (_result, args) => clean({ id: str(args.issueKey), label: str(args.issueKey) || undefined }),
  },

  // Asana
  asana_create_task: {
    undoable: true,
    effect: 'Deletes the task (Asana keeps it in the trash for 30 days).',
    ref: (result) => {
      const data = record(record(result)?.data)
      return clean({ id: str(data?.gid), url: str(data?.permalink_url) })
    },
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/api/1.0/tasks/${seg(input.ref.id)}` }),
  },
  asana_update_task: {
    undoable: false,
    reason: 'The update takes any field Asana accepts, and earlier values aren\'t captured, so there is nothing to restore.',
    ref: (_result, args) => clean({ id: str(args.taskGid) }),
  },

  // Notion
  notion_create_page: {
    undoable: true,
    effect: 'Archives the page (restorable from Notion\'s trash).',
    ref: (result) => clean({ id: str(record(result)?.id), url: str(record(result)?.url) }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `/v1/pages/${seg(input.ref.id)}`, headers: { 'Notion-Version': '2022-06-28' }, data: { archived: true } }),
  },
  notion_update_page: {
    undoable: true,
    effect: 'Removes the text the agent appended.',
    ref: (result, args) => {
      const results = record(result)?.results
      const blockIds = Array.isArray(results) ? results.map((block) => str(record(block)?.id)).filter(Boolean).slice(0, 50) : []
      return clean({ id: str(args.pageId), blockIds })
    },
    missing: (input) => (Array.isArray(input.ref.blockIds) && input.ref.blockIds.length ? null : "Notion didn't return the appended blocks, so there is nothing to remove."),
    undo: async (connection, input, proxy = defaultProxy()) => {
      for (const id of input.ref.blockIds as string[]) {
        await call(connection, proxy, { method: 'DELETE', endpoint: `/v1/blocks/${seg(id)}`, headers: { 'Notion-Version': '2022-06-28' } })
      }
      return { removed: (input.ref.blockIds as string[]).length }
    },
  },

  // Confluence
  confluence_create_page: {
    undoable: true,
    effect: 'Deletes the page (it goes to the space\'s trash).',
    ref: (result) => {
      const data = record(result)
      const links = record(data?._links)
      return clean({ id: str(data?.id), url: links?.base && links?.webui ? `${str(links.base)}${str(links.webui)}` : undefined })
    },
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/wiki/rest/api/content/${seg(input.ref.id)}` }),
  },

  // Google Drive
  google_drive_upload_file: {
    undoable: true,
    effect: 'Moves the file to the Drive trash.',
    ref: (result) => clean({ id: str(record(result)?.id), url: str(record(result)?.webViewLink), label: str(record(result)?.name) || undefined }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `/drive/v3/files/${seg(input.ref.id)}`, data: { trashed: true } }),
  },

  // Google Sheets
  google_sheets_append_row: {
    undoable: true,
    effect: 'Clears the row the agent appended.',
    ref: (result, args) => clean({ id: str(args.spreadsheetId), range: str(record(record(result)?.updates)?.updatedRange) }),
    missing: (input) => needs(input, 'id', 'range'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'POST', endpoint: `/v4/spreadsheets/${seg(input.ref.id)}/values/${encodeURIComponent(str(input.ref.range))}:clear`, data: {} }),
  },
  google_sheets_update_range: {
    undoable: true,
    effect: 'Writes the earlier cell values back into the range.',
    ref: (result, args) => clean({ id: str(args.spreadsheetId), range: str(record(result)?.updatedRange) || str(args.range) }),
    captureBefore: async (connection, args, proxy = defaultProxy()) => {
      const current = record(await call(connection, proxy, {
        method: 'GET',
        endpoint: `/v4/spreadsheets/${seg(args.spreadsheetId)}/values/${encodeURIComponent(str(args.range))}`,
        params: { valueRenderOption: 'FORMULA' },
      }))
      if (!current) return null
      // Sheets omits trailing empty cells, so pad the earlier values to the
      // shape that was written — otherwise restoring would leave the new
      // values standing wherever the range used to be blank.
      const written = Array.isArray(args.values) ? (args.values as unknown[]) : []
      const before = Array.isArray(current.values) ? (current.values as unknown[][]) : []
      const rows = Math.max(written.length, before.length)
      const values = Array.from({ length: rows }, (_, r) => {
        const width = Math.max(Array.isArray(written[r]) ? (written[r] as unknown[]).length : 0, before[r]?.length ?? 0)
        return Array.from({ length: width }, (_, c) => before[r]?.[c] ?? '')
      })
      return { range: str(current.range) || str(args.range), values }
    },
    missing: (input) => needs(input, 'id') ?? (Array.isArray(record(input.before)?.values) ? null : "The earlier cell values couldn't be read before this change, so there is nothing to restore."),
    undo: (connection, input, proxy = defaultProxy()) => {
      const before = record(input.before)!
      return call(connection, proxy, {
        method: 'PUT',
        endpoint: `/v4/spreadsheets/${seg(input.ref.id)}/values/${encodeURIComponent(str(before.range))}`,
        params: { valueInputOption: 'USER_ENTERED' },
        data: { values: before.values },
      })
    },
  },

  // Monday
  monday_create_item: {
    undoable: true,
    effect: 'Deletes the item.',
    ref: (result) => clean({ id: str(record(record(record(result)?.data)?.create_item)?.id) }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'POST', endpoint: '/v2', data: { query: 'mutation ($id: ID!) { delete_item (item_id: $id) { id } }', variables: { id: input.ref.id } } }),
  },

  // Zendesk
  zendesk_create_ticket: {
    undoable: true,
    effect: 'Deletes the ticket (Zendesk keeps deleted tickets restorable for 30 days).',
    ref: (result) => clean({ id: str(record(record(result)?.ticket)?.id) }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/api/v2/tickets/${seg(input.ref.id)}.json` }),
  },
  zendesk_update_ticket: {
    undoable: false,
    reason: "A comment added to a ticket can't be removed, and earlier field values aren't captured.",
    ref: (_result, args) => clean({ id: str(args.ticketId) }),
  },

  // Google Calendar
  google_calendar_create_event: {
    undoable: true,
    effect: 'Deletes the event (attendees get a cancellation).',
    ref: (result, args) => clean({ id: str(record(result)?.id), url: str(record(result)?.htmlLink), calendarId: str(args.calendarId) || 'primary', label: str(args.summary) || undefined }),
    missing: (input) => needs(input, 'id'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/calendar/v3/calendars/${seg(input.ref.calendarId || 'primary')}/events/${seg(input.ref.id)}` }),
  },
  google_calendar_update_event: {
    undoable: true,
    effect: 'Puts the changed event details back to their earlier values.',
    ref: (result, args) => clean({ id: str(args.eventId), url: str(record(result)?.htmlLink), calendarId: str(args.calendarId) || 'primary' }),
    captureBefore: async (connection, args, proxy = defaultProxy()) => {
      const touched = ['summary', 'description', 'location', 'start', 'end'].filter((field) => str(args[field]))
      if (!touched.length) return null
      const event = record(await call(connection, proxy, { method: 'GET', endpoint: `/calendar/v3/calendars/${seg(str(args.calendarId) || 'primary')}/events/${seg(args.eventId)}` }))
      // PATCH with "" clears a text field, which is what restores one that was unset.
      return event ? Object.fromEntries(touched.map((field) => [field, event[field] ?? (field === 'start' || field === 'end' ? null : '')])) : null
    },
    missing: (input) => needs(input, 'id') ?? needsBefore(input),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: `/calendar/v3/calendars/${seg(input.ref.calendarId || 'primary')}/events/${seg(input.ref.id)}`, data: input.before }),
  },

  // Airtable
  airtable_create_record: {
    undoable: true,
    effect: 'Deletes the record.',
    ref: (result, args) => clean({ id: str(record(result)?.id), baseId: str(args.baseId), table: str(args.table) }),
    missing: (input) => needs(input, 'id', 'baseId', 'table'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: airtablePath(input.ref.baseId as string, input.ref.table as string, input.ref.id) }),
  },
  airtable_update_record: {
    undoable: true,
    effect: 'Puts the changed fields back to their earlier values.',
    ref: (_result, args) => clean({ id: str(args.recordId), baseId: str(args.baseId), table: str(args.table) }),
    captureBefore: async (connection, args, proxy = defaultProxy()) => {
      const fields = touchedKeys(args.fields)
      if (!fields.length) return null
      const current = record(record(await call(connection, proxy, { method: 'GET', endpoint: airtablePath(str(args.baseId), str(args.table), str(args.recordId)) }))?.fields)
      // Airtable omits empty fields from a read; null clears one on write.
      return current ? Object.fromEntries(fields.map((field) => [field, current[field] ?? null])) : null
    },
    missing: (input) => needs(input, 'id', 'baseId', 'table') ?? needsBefore(input),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'PATCH', endpoint: airtablePath(input.ref.baseId as string, input.ref.table as string, input.ref.id), data: { fields: input.before } }),
  },

  // Figma
  figma_post_comment: {
    undoable: true,
    effect: 'Deletes the comment.',
    ref: (result, args) => clean({ id: str(record(result)?.id), fileKey: str(args.fileKey) }),
    missing: (input) => needs(input, 'id', 'fileKey'),
    undo: (connection, input, proxy = defaultProxy()) =>
      call(connection, proxy, { method: 'DELETE', endpoint: `/v1/files/${seg(input.ref.fileKey)}/comments/${seg(input.ref.id)}` }),
  },
}

function airtablePath(baseId: string, table: string, recordId?: string) {
  return `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}${recordId ? `/${encodeURIComponent(recordId)}` : ''}`
}

// ── Native planes and everything else ────────────────────────────────────────

/** The native Slack plane posts with the workspace bot, so its undo deletes with the bot. */
const NATIVE_COMPENSATIONS: Record<string, Compensation> = {
  'slack:post_message': slackDelete,
}

const WAREHOUSE_REASON = "Warehouse changes can't be reversed from here — restore from the warehouse's own history (Time Travel) if you need to."
const PLANE_REASONS: Record<string, string> = {
  databricks: WAREHOUSE_REASON,
  snowflake: WAREHOUSE_REASON,
  email: "Sent email can't be recalled — it is already in the recipient's inbox.",
  http: 'A raw API request has no known reverse action.',
  data_tables: "Data table edits aren't reversible from here yet — change the row back in Data Tables.",
}

/**
 * The compensation for one ledger entry's tool. Always answers: tools without
 * a compensator come back `undoable: false` with the reason a person sees.
 */
export function compensationFor(entry: { plane: string; provider: string; tool: string }): Compensation {
  // An external agent's ledger: tasks handed over and replies received.
  if (entry.plane === 'external') {
    return entry.tool === 'reply_received'
      ? { undoable: false, reason: 'A reply received from the agent — it changed nothing outside Backstory.' }
      : { undoable: false, reason: 'A task handed to an external agent cannot be recalled: it already has what was sent.' }
  }
  if (entry.provider.startsWith('nango:')) {
    return NANGO_COMPENSATIONS[entry.tool] ?? { undoable: false, reason: 'No reverse action is defined for this tool yet.' }
  }
  const native = NATIVE_COMPENSATIONS[`${entry.provider}:${entry.tool}`]
  if (native) return native
  if (entry.tool === 'databricks_run_job') return { undoable: false, reason: "A job run can't be un-run — whatever the job changed stays changed." }
  const reason = PLANE_REASONS[entry.provider]
  if (reason) return { undoable: false, reason }
  if (entry.plane === 'mcp' || entry.plane === 'people_ai') {
    return { undoable: false, reason: "This server doesn't describe how to reverse its actions, so Backstory can't undo them." }
  }
  return { undoable: false, reason: 'No reverse action is known for this tool.' }
}

/**
 * A Nango-shaped transport over the Slack Web API with the workspace bot token,
 * so the native Slack plane's undo reuses the same compensator as the Nango
 * plane — and goes out on the same credential its write did.
 */
export function slackBotProxy(token: string, fetchImpl: typeof fetch = fetch): NangoProxy {
  return async (request) => {
    const response = await fetchImpl(`https://slack.com/api${request.endpoint}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: request.data === undefined ? undefined : JSON.stringify(request.data),
      signal: AbortSignal.timeout(20_000),
    })
    return { data: await response.json() }
  }
}
