/**
 * Nango multi-provider agent tools.
 *
 * Each tool is a hand-authored adapter that maps tool args → a provider REST/GraphQL call
 * through Nango's proxy (credentials never touch our process). Unlike the
 * write-only delivery adapters, these carry a per-tool `isWrite` flag so read
 * tools (list/search/get) skip the approval gate while writes (create/update/
 * comment) keep it.
 *
 * Adding a provider = append its read + write specs here and map its Nango
 * connection config key(s) in PROVIDER_CONFIG_KEYS.
 */

import { randomBytes } from 'node:crypto'
import { type DeliveryConnection, type NangoProxy, defaultProxy, DELIVERY_TOOLS, DELIVERY_PROVIDERS } from './delivery'

export type NangoToolSpec = {
  /** Capability/provider key, e.g. 'github'. Runtime provider id is `nango:<provider>`. */
  provider: string
  /** Tool name exposed to the agent, e.g. 'github_list_repositories'. */
  name: string
  description: string
  /** Read tools skip the approval gate; writes are gated + audited. */
  isWrite: boolean
  inputSchema: Record<string, unknown>
  run: (connection: DeliveryConnection, args: Record<string, unknown>, proxy?: NangoProxy) => Promise<unknown>
}

/**
 * Provider key → Nango connection config key(s) to resolve a connection from.
 * The first is the canonical Nango dashboard integration id; alternates cover
 * naming variants. Extend as providers are added.
 */
export const PROVIDER_CONFIG_KEYS: Record<string, readonly string[]> = {
  github: ['github'],
  linear: ['linear'],
  jira: ['jira', 'atlassian'],
  asana: ['asana'],
  notion: ['notion'],
  hubspot: ['hubspot'],
  confluence: ['confluence'],
  zendesk: ['zendesk'],
  monday: ['monday'],
  google_drive: ['google-drive', 'google_drive'],
  google_sheets: ['google-sheet', 'google-sheets', 'google_sheets'],
  slack: ['slack'],
  gmail: ['google-mail', 'gmail'],
  salesforce: ['salesforce', 'salesforce-sandbox'],
  airtable: ['airtable'],
  figma: ['figma'],
}

/** Provider keys offered to agent drafting and template generation. */
export const NANGO_PROVIDERS = Object.keys(PROVIDER_CONFIG_KEYS)

const str = (v: unknown) => (v == null ? '' : String(v))
const num = (v: unknown, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}
// URL-encode a path segment built from tool args. Args originate from the LLM
// (steerable by prompt-injected content), so a raw '/', '..', '?', or '#' could
// traverse to another resource or inject query params on the authenticated host.
const seg = (v: unknown) => encodeURIComponent(str(v))

// ── GitHub (REST v3) ──────────────────────────────────────────────────────────

const GITHUB_TOOLS: NangoToolSpec[] = [
  {
    provider: 'github',
    name: 'github_list_repositories',
    description: 'List repositories for the connected user, or for a given user/organization.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Optional user or org login. Omit for the connected account’s repos.' },
        per_page: { type: 'number', description: 'Max repos to return (default 30).' },
      },
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const owner = str(args.owner).trim()
      const endpoint = owner ? `/users/${encodeURIComponent(owner)}/repos` : '/user/repos'
      return proxy({
        method: 'GET',
        endpoint,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { per_page: num(args.per_page, 30), sort: 'updated' },
      }).then((r) => r.data)
    },
  },
  {
    provider: 'github',
    name: 'github_list_pull_requests',
    description: 'List and read pull requests on a repository.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open | closed | all (default open).' },
      },
      required: ['owner', 'repo'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: `/repos/${seg(args.owner)}/${seg(args.repo)}/pulls`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: { state: str(args.state) || 'open', per_page: num(args.per_page, 30) },
      }).then((r) => r.data),
  },
  {
    provider: 'github',
    name: 'github_create_issue',
    description: 'Open a new issue on a repository with a title and body.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: `/repos/${seg(args.owner)}/${seg(args.repo)}/issues`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { title: str(args.title), ...(args.body != null ? { body: str(args.body) } : {}) },
      }).then((r) => r.data),
  },
  {
    provider: 'github',
    name: 'github_comment',
    description: 'Add a comment to an issue or pull request.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number', description: 'Issue or PR number.' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: `/repos/${seg(args.owner)}/${seg(args.repo)}/issues/${num(args.issue_number, 0)}/comments`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { body: str(args.body) },
      }).then((r) => r.data),
  },
]

// ── Linear (GraphQL) ──────────────────────────────────────────────────────────

const linearGraphql = (connection: DeliveryConnection, query: string, variables: Record<string, unknown>, proxy: NangoProxy) =>
  proxy({
    method: 'POST',
    endpoint: '/graphql',
    connectionId: connection.connectionId,
    providerConfigKey: connection.providerConfigKey,
    data: { query, variables },
  }).then((r) => r.data)

const LINEAR_TOOLS: NangoToolSpec[] = [
  {
    provider: 'linear',
    name: 'linear_list_issues',
    description: 'Search and list Linear issues, optionally filtered by a text query.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional free-text search.' },
        first: { type: 'number', description: 'Max issues (default 25).' },
      },
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const q = str(args.query).trim()
      const gql = `query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter) {
          nodes { id identifier title state { name } assignee { name } updatedAt }
        }
      }`
      const filter = q ? { searchableContent: { contains: q } } : undefined
      return linearGraphql(connection, gql, { first: num(args.first, 25), filter }, proxy)
    },
  },
  {
    provider: 'linear',
    name: 'linear_create_issue',
    description: 'Create a Linear issue in a team with a title and optional description/assignee.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Linear team id the issue belongs to.' },
        title: { type: 'string' },
        description: { type: 'string' },
        assigneeId: { type: 'string' },
      },
      required: ['teamId', 'title'],
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const gql = `mutation Create($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`
      const input: Record<string, unknown> = { teamId: str(args.teamId), title: str(args.title) }
      if (args.description != null) input.description = str(args.description)
      if (args.assigneeId != null) input.assigneeId = str(args.assigneeId)
      return linearGraphql(connection, gql, { input }, proxy)
    },
  },
  {
    provider: 'linear',
    name: 'linear_update_issue',
    description: 'Update a Linear issue’s state, assignee, or title.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Issue id to update.' },
        stateId: { type: 'string' },
        assigneeId: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['id'],
    },
    run: (connection, args, proxy = defaultProxy()) => {
      const gql = `mutation Update($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { id identifier state { name } } }
      }`
      const input: Record<string, unknown> = {}
      if (args.stateId != null) input.stateId = str(args.stateId)
      if (args.assigneeId != null) input.assigneeId = str(args.assigneeId)
      if (args.title != null) input.title = str(args.title)
      return linearGraphql(connection, gql, { id: str(args.id), input }, proxy)
    },
  },
]

// ── Jira (REST v3) ────────────────────────────────────────────────────────────

const JIRA_TOOLS: NangoToolSpec[] = [
  {
    provider: 'jira', name: 'jira_list_issues', isWrite: false,
    description: 'Search Jira issues with JQL, or list a project’s issues.',
    inputSchema: { type: 'object', properties: { jql: { type: 'string', description: 'JQL query.' }, project: { type: 'string', description: 'Project key (used when jql is omitted).' } } },
    run: (c, a, proxy = defaultProxy()) => {
      const jql = str(a.jql).trim() || (str(a.project) ? `project = ${str(a.project)} ORDER BY updated DESC` : 'ORDER BY updated DESC')
      // /rest/api/3/search was removed (May 2025); the enhanced-search endpoint
      // is /search/jql and requires an explicit fields list.
      return proxy({ method: 'GET', endpoint: '/rest/api/3/search/jql', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { jql, maxResults: num(a.maxResults, 25), fields: 'summary,status,assignee,updated,issuetype' } }).then((r) => r.data)
    },
  },
  {
    provider: 'jira', name: 'jira_create_issue', isWrite: true,
    description: 'Create a Jira issue in a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project key.' }, summary: { type: 'string' }, issueType: { type: 'string', description: 'e.g. Task, Bug (default Task).' }, description: { type: 'string' } }, required: ['project', 'summary'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/rest/api/3/issue', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      // Jira Cloud v3 requires `description` in Atlassian Document Format (a
      // string returns 400), so wrap the plain text in a minimal ADF doc.
      data: { fields: { project: { key: str(a.project) }, summary: str(a.summary), issuetype: { name: str(a.issueType) || 'Task' }, ...(a.description != null ? { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: str(a.description) }] }] } } : {}) } },
    }).then((r) => r.data),
  },
  {
    provider: 'jira', name: 'jira_update_issue', isWrite: true,
    description: 'Edit fields on an existing Jira issue.',
    inputSchema: { type: 'object', properties: { issueKey: { type: 'string' }, fields: { type: 'object', description: 'Jira field map to set.' } }, required: ['issueKey', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PUT', endpoint: `/rest/api/3/issue/${seg(a.issueKey)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { fields: (a.fields as Record<string, unknown>) ?? {} },
    }).then((r) => r.data),
  },
]

// ── Asana (REST 1.0) ──────────────────────────────────────────────────────────

const ASANA_TOOLS: NangoToolSpec[] = [
  {
    provider: 'asana', name: 'asana_list_tasks', isWrite: false,
    description: 'List tasks in a project.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project gid.' } }, required: ['project'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/api/1.0/tasks', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { project: str(a.project), limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'asana', name: 'asana_create_task', isWrite: true,
    description: 'Create an Asana task with a name, notes, and optional due date.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' }, due_on: { type: 'string', description: 'YYYY-MM-DD.' } }, required: ['project', 'name'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/api/1.0/tasks', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { data: { name: str(a.name), projects: [str(a.project)], ...(a.notes != null ? { notes: str(a.notes) } : {}), ...(a.due_on != null ? { due_on: str(a.due_on) } : {}) } },
    }).then((r) => r.data),
  },
  {
    provider: 'asana', name: 'asana_update_task', isWrite: true,
    description: 'Update an Asana task’s fields or completion state.',
    inputSchema: { type: 'object', properties: { taskGid: { type: 'string' }, fields: { type: 'object', description: 'Fields to set, e.g. {completed:true}.' } }, required: ['taskGid', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PUT', endpoint: `/api/1.0/tasks/${seg(a.taskGid)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { data: (a.fields as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Notion (REST v1; requires a version header) ───────────────────────────────

const NOTION_VERSION = '2022-06-28'
const notionHeaders = { 'Notion-Version': NOTION_VERSION }

const NOTION_TOOLS: NangoToolSpec[] = [
  {
    provider: 'notion', name: 'notion_search', isWrite: false,
    description: 'Search Notion pages and databases by keyword.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/v1/search', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders, data: { query: str(a.query) } }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_read_page', isWrite: false,
    description: 'Read a Notion page’s block content.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/v1/blocks/${seg(a.pageId)}/children`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_create_page', isWrite: true,
    description: 'Create a Notion page under a parent page or database.',
    inputSchema: { type: 'object', properties: { parentId: { type: 'string', description: 'Parent page or database id.' }, title: { type: 'string' } }, required: ['parentId', 'title'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/v1/pages', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders,
      data: { parent: { page_id: str(a.parentId) }, properties: { title: { title: [{ text: { content: str(a.title) } }] } } },
    }).then((r) => r.data),
  },
  {
    provider: 'notion', name: 'notion_update_page', isWrite: true,
    description: 'Append text blocks to a Notion page.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, text: { type: 'string' } }, required: ['pageId', 'text'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PATCH', endpoint: `/v1/blocks/${seg(a.pageId)}/children`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, headers: notionHeaders,
      data: { children: [{ paragraph: { rich_text: [{ text: { content: str(a.text) } }] } }] },
    }).then((r) => r.data),
  },
]

// ── HubSpot (CRM v3) ──────────────────────────────────────────────────────────

const HUBSPOT_TOOLS: NangoToolSpec[] = [
  {
    provider: 'hubspot', name: 'hubspot_list_contacts', isWrite: false,
    description: 'List CRM contacts.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/crm/v3/objects/contacts', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_create_contact', isWrite: true,
    description: 'Create a HubSpot contact.',
    inputSchema: { type: 'object', properties: { properties: { type: 'object', description: 'e.g. {email,firstname,lastname}.' } }, required: ['properties'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/crm/v3/objects/contacts', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { properties: (a.properties as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_list_deals', isWrite: false,
    description: 'List deals in the pipeline.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/crm/v3/objects/deals', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: num(a.limit, 50) } }).then((r) => r.data),
  },
  {
    provider: 'hubspot', name: 'hubspot_update_deal', isWrite: true,
    description: 'Update a deal’s stage or properties.',
    inputSchema: { type: 'object', properties: { dealId: { type: 'string' }, properties: { type: 'object' } }, required: ['dealId', 'properties'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PATCH', endpoint: `/crm/v3/objects/deals/${seg(a.dealId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { properties: (a.properties as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Confluence (REST) ─────────────────────────────────────────────────────────

const CONFLUENCE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'confluence', name: 'confluence_search', isWrite: false,
    description: 'Search Confluence content with CQL.',
    inputSchema: { type: 'object', properties: { cql: { type: 'string', description: 'CQL query, e.g. text~"launch".' } }, required: ['cql'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/wiki/rest/api/search', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { cql: str(a.cql), limit: num(a.limit, 25) } }).then((r) => r.data),
  },
  {
    provider: 'confluence', name: 'confluence_read_page', isWrite: false,
    description: 'Read a Confluence page’s content.',
    inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/wiki/rest/api/content/${seg(a.pageId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { expand: 'body.storage' } }).then((r) => r.data),
  },
  {
    provider: 'confluence', name: 'confluence_create_page', isWrite: true,
    description: 'Create a Confluence page in a space.',
    inputSchema: { type: 'object', properties: { spaceKey: { type: 'string' }, title: { type: 'string' }, body: { type: 'string', description: 'Storage-format HTML.' } }, required: ['spaceKey', 'title', 'body'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: '/wiki/rest/api/content', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      data: { type: 'page', space: { key: str(a.spaceKey) }, title: str(a.title), body: { storage: { value: str(a.body), representation: 'storage' } } },
    }).then((r) => r.data),
  },
]

// ── Google Drive (v3) ─────────────────────────────────────────────────────────

/** Mime type from a filename's extension — the small set flows produce. */
function driveMimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Drive multipart upload (uploadType=multipart): a JSON metadata part carrying
 * the filename (and folder), then the media part base64-encoded. `media`
 * uploads can't set a name — every file lands as "Untitled" — which is why
 * imports that fell back to raw HTTP produced nameless, unauthenticated
 * uploads. Exported for tests.
 */
export function buildDriveMultipartUpload(args: { filename: string; content: string; mimeType?: string; folderId?: string }): { body: string; contentType: string } {
  const boundary = `bs_${randomBytes(12).toString('hex')}`
  const mimeType = args.mimeType?.trim() || driveMimeFromFilename(args.filename)
  const metadata: Record<string, unknown> = { name: args.filename, ...(args.folderId ? { parents: [args.folderId] } : {}) }
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(args.content, 'utf8').toString('base64'),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  return { body, contentType: `multipart/related; boundary="${boundary}"` }
}

const GDRIVE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'google_drive', name: 'google_drive_list_files', isWrite: false,
    description: 'List Google Drive files and folders, optionally filtered.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Drive query, e.g. name contains "report".' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/drive/v3/files', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { ...(str(a.q) ? { q: str(a.q) } : {}), pageSize: num(a.pageSize, 50), fields: 'files(id,name,mimeType,modifiedTime)' } }).then((r) => r.data),
  },
  {
    provider: 'google_drive', name: 'google_drive_read_file', isWrite: false,
    description: 'Read a Google Drive file’s metadata (and text when exportable).',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/drive/v3/files/${seg(a.fileId)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { fields: 'id,name,mimeType,webViewLink' } }).then((r) => r.data),
  },
  {
    provider: 'google_drive', name: 'google_drive_upload_file', isWrite: true,
    description: 'Upload a text-based file (HTML, CSV, Markdown, JSON…) to Google Drive with a real filename, optionally into a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The file name, extension included (e.g. report.html).' },
        content: { type: 'string', description: 'The file content as text.' },
        mimeType: { type: 'string', description: 'Optional — inferred from the extension when omitted.' },
        folderId: { type: 'string', description: 'Optional Drive folder id to upload into.' },
      },
      required: ['filename', 'content'],
    },
    run: async (c, a, proxy = defaultProxy()) => {
      const filename = str(a.filename)
      const content = typeof a.content === 'string' ? a.content : ''
      if (!content) throw new Error('Google Drive upload needs text content — pass the file body in "content".')
      const upload = buildDriveMultipartUpload({ filename, content, mimeType: str(a.mimeType) || undefined, folderId: str(a.folderId) || undefined })
      const response = await proxy({
        method: 'POST',
        endpoint: '/upload/drive/v3/files',
        connectionId: c.connectionId,
        providerConfigKey: c.providerConfigKey,
        params: { uploadType: 'multipart', fields: 'id,name,mimeType,webViewLink' },
        headers: { 'Content-Type': upload.contentType },
        data: upload.body,
      })
      return response.data
    },
  },
]

// ── Google Sheets (v4) ────────────────────────────────────────────────────────

const GSHEETS_TOOLS: NangoToolSpec[] = [
  {
    provider: 'google_sheets', name: 'google_sheets_read_range', isWrite: false,
    description: 'Read values from a Google Sheets range (A1 notation).',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string', description: 'e.g. Sheet1!A1:D10.' } }, required: ['spreadsheetId', 'range'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/v4/spreadsheets/${seg(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'google_sheets', name: 'google_sheets_append_row', isWrite: true,
    description: 'Append a row of values to a Google Sheet.',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', description: 'One row: array of cell values.' } }, required: ['spreadsheetId', 'range', 'values'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'POST', endpoint: `/v4/spreadsheets/${seg(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}:append`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      params: { valueInputOption: 'USER_ENTERED' }, data: { values: [Array.isArray(a.values) ? a.values : [a.values]] },
    }).then((r) => r.data),
  },
  {
    provider: 'google_sheets', name: 'google_sheets_update_range', isWrite: true,
    description: 'Write values into a Google Sheets range.',
    inputSchema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array', description: 'Rows: array of arrays.' } }, required: ['spreadsheetId', 'range', 'values'] },
    run: (c, a, proxy = defaultProxy()) => proxy({
      method: 'PUT', endpoint: `/v4/spreadsheets/${seg(a.spreadsheetId)}/values/${encodeURIComponent(str(a.range))}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey,
      params: { valueInputOption: 'USER_ENTERED' }, data: { values: (a.values as unknown[]) ?? [] },
    }).then((r) => r.data),
  },
]

// ── Monday (GraphQL v2) ───────────────────────────────────────────────────────

const mondayGraphql = (c: DeliveryConnection, query: string, proxy: NangoProxy, variables?: Record<string, unknown>) =>
  proxy({ method: 'POST', endpoint: '/v2', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: variables ? { query, variables } : { query } }).then((r) => r.data)

const MONDAY_TOOLS: NangoToolSpec[] = [
  {
    provider: 'monday', name: 'monday_list_boards', isWrite: false,
    description: 'List Monday.com boards and their columns.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => mondayGraphql(c, 'query { boards (limit: 50) { id name columns { id title type } } }', proxy),
  },
  {
    provider: 'monday', name: 'monday_create_item', isWrite: true,
    description: 'Add an item to a Monday.com board.',
    inputSchema: { type: 'object', properties: { boardId: { type: 'string' }, itemName: { type: 'string' } }, required: ['boardId', 'itemName'] },
    // GraphQL VARIABLES (not string interpolation): boardId/itemName come from
    // the LLM, so interpolating them into the query is an injection vector.
    run: (c, a, proxy = defaultProxy()) => mondayGraphql(
      c,
      'mutation ($boardId: ID!, $itemName: String!) { create_item (board_id: $boardId, item_name: $itemName) { id } }',
      proxy,
      { boardId: str(a.boardId), itemName: str(a.itemName) },
    ),
  },
]

// ── Zendesk (API v2) ──────────────────────────────────────────────────────────

const ZENDESK_TOOLS: NangoToolSpec[] = [
  {
    provider: 'zendesk', name: 'zendesk_list_tickets', isWrite: false,
    description: 'List Zendesk support tickets.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/api/v2/tickets.json', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'zendesk', name: 'zendesk_create_ticket', isWrite: true,
    description: 'Open a Zendesk ticket.',
    inputSchema: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/api/v2/tickets.json', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { ticket: { subject: str(a.subject), comment: { body: str(a.body) } } } }).then((r) => r.data),
  },
  {
    provider: 'zendesk', name: 'zendesk_update_ticket', isWrite: true,
    description: 'Update a Zendesk ticket’s status/priority or add a comment.',
    inputSchema: { type: 'object', properties: { ticketId: { type: 'string' }, ticket: { type: 'object', description: 'Ticket fields to set.' } }, required: ['ticketId', 'ticket'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PUT', endpoint: `/api/v2/tickets/${seg(a.ticketId)}.json`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { ticket: (a.ticket as Record<string, unknown>) ?? {} } }).then((r) => r.data),
  },
]

// ── Slack tools (the channel-post write lives in delivery.ts) ─────────────────
// Kept at parity with the actions enabled on the Nango Slack integration:
// add-reaction, get-conversation-history (read messages), post-message
// (delivery.ts), search-messages, send-message (direct message).

const SLACK_TOOLS: NangoToolSpec[] = [
  {
    provider: 'slack', name: 'slack_list_channels', isWrite: false,
    description: 'List Slack channels the connected account can access.',
    inputSchema: { type: 'object', properties: {} },
    run: (c, _a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/conversations.list', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { limit: 100, types: 'public_channel,private_channel' } }).then((r) => r.data),
  },
  {
    provider: 'slack', name: 'slack_read_messages', isWrite: false,
    description: 'Read recent messages from a Slack channel.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id.' }, limit: { type: 'number' } }, required: ['channel'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/conversations.history', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { channel: str(a.channel), limit: num(a.limit, 30) } }).then((r) => r.data),
  },
  {
    provider: 'slack', name: 'slack_search_messages', isWrite: false,
    description: 'Search messages across the connected Slack workspace.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Slack search query, e.g. "deploy in:#eng after:2026-08-01".' }, count: { type: 'number', description: 'Max results (default 20).' } }, required: ['query'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/search.messages', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { query: str(a.query), count: num(a.count, 20) } }).then((r) => r.data),
  },
  {
    provider: 'slack', name: 'slack_add_reaction', isWrite: true,
    description: 'Add an emoji reaction to a Slack message.',
    inputSchema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id of the message.' }, timestamp: { type: 'string', description: 'Message timestamp (ts).' }, name: { type: 'string', description: 'Emoji name without colons, e.g. thumbsup.' } }, required: ['channel', 'timestamp', 'name'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'POST', endpoint: '/reactions.add', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { channel: str(a.channel), timestamp: str(a.timestamp), name: str(a.name).replace(/:/g, '') } }).then((r) => r.data),
  },
  {
    provider: 'slack', name: 'slack_send_direct_message', isWrite: true,
    description: 'Send a direct message to a Slack user.',
    inputSchema: { type: 'object', properties: { user: { type: 'string', description: 'The user id to message (e.g. U0123456).' }, text: { type: 'string' } }, required: ['user', 'text'] },
    run: async (c, a, proxy = defaultProxy()) => {
      // A DM posts into the user's IM conversation, which must be opened (or
      // re-opened) first — conversations.open is idempotent for an existing IM.
      const opened = await proxy({ method: 'POST', endpoint: '/conversations.open', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { users: str(a.user) } })
      const channel = (opened.data as { channel?: { id?: string } })?.channel?.id
      if (!channel) throw new Error('Slack did not open a direct-message conversation for that user id.')
      return proxy({ method: 'POST', endpoint: '/chat.postMessage', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: { channel, text: str(a.text) } }).then((r) => r.data)
    },
  },
]

// ── Salesforce read/update (create lives in delivery.ts) ──────────────────────

const SALESFORCE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'salesforce', name: 'salesforce_query', isWrite: false,
    description: 'Run a SOQL query over Salesforce records.',
    inputSchema: { type: 'object', properties: { soql: { type: 'string', description: 'e.g. SELECT Id, Name FROM Account LIMIT 10.' } }, required: ['soql'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/services/data/v60.0/query', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { q: str(a.soql) } }).then((r) => r.data),
  },
  {
    provider: 'salesforce', name: 'salesforce_get_record', isWrite: false,
    description: 'Read a Salesforce record by object type and id.',
    inputSchema: { type: 'object', properties: { sobject: { type: 'string' }, id: { type: 'string' } }, required: ['sobject', 'id'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/services/data/v60.0/sobjects/${seg(a.sobject)}/${seg(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey }).then((r) => r.data),
  },
  {
    provider: 'salesforce', name: 'salesforce_update_record', isWrite: true,
    description: 'Update fields on an existing Salesforce record.',
    inputSchema: { type: 'object', properties: { sobject: { type: 'string' }, id: { type: 'string' }, fields: { type: 'object' } }, required: ['sobject', 'id', 'fields'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'PATCH', endpoint: `/services/data/v60.0/sobjects/${seg(a.sobject)}/${seg(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, data: (a.fields as Record<string, unknown>) ?? {} }).then((r) => r.data),
  },
]

// ── Gmail read/draft (the write send lives in delivery.ts) ────────────────────

const GMAIL_READ_TOOLS: NangoToolSpec[] = [
  {
    provider: 'gmail', name: 'gmail_list_messages', isWrite: false,
    description: 'Search and list Gmail messages.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Gmail search, e.g. from:acme is:unread.' } } },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: '/gmail/v1/users/me/messages', connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { ...(str(a.q) ? { q: str(a.q) } : {}), maxResults: num(a.maxResults, 25) } }).then((r) => r.data),
  },
  {
    provider: 'gmail', name: 'gmail_read_message', isWrite: false,
    description: 'Read the full content of a Gmail message.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (c, a, proxy = defaultProxy()) => proxy({ method: 'GET', endpoint: `/gmail/v1/users/me/messages/${seg(a.id)}`, connectionId: c.connectionId, providerConfigKey: c.providerConfigKey, params: { format: 'full' } }).then((r) => r.data),
  },
]

// ── Airtable (REST API v0) ────────────────────────────────────────────────────
// Path segments are URL-encoded: a table can be referenced by its human name
// (spaces/punctuation), unlike the id-like keys the other providers use.
const airtablePath = (baseId: string, table: string, recordId?: string) =>
  `/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}${recordId ? `/${encodeURIComponent(recordId)}` : ''}`

const AIRTABLE_TOOLS: NangoToolSpec[] = [
  {
    provider: 'airtable',
    name: 'airtable_list_records',
    description: 'List records from an Airtable table, optionally filtered by a formula.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: 'Airtable base id (starts with app…).' },
        table: { type: 'string', description: 'Table id or name.' },
        maxRecords: { type: 'number', description: 'Max records to return (default 100).' },
        view: { type: 'string', description: 'Optional view name/id to read from.' },
        filterByFormula: { type: 'string', description: 'Optional Airtable formula to filter rows.' },
      },
      required: ['baseId', 'table'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: airtablePath(str(args.baseId), str(args.table)),
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        params: {
          maxRecords: num(args.maxRecords, 100),
          ...(str(args.view) ? { view: str(args.view) } : {}),
          ...(str(args.filterByFormula) ? { filterByFormula: str(args.filterByFormula) } : {}),
        },
      }).then((r) => r.data),
  },
  {
    provider: 'airtable',
    name: 'airtable_get_record',
    description: 'Fetch a single Airtable record by id.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        table: { type: 'string' },
        recordId: { type: 'string', description: 'Record id (starts with rec…).' },
      },
      required: ['baseId', 'table', 'recordId'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: airtablePath(str(args.baseId), str(args.table), str(args.recordId)),
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
      }).then((r) => r.data),
  },
  {
    provider: 'airtable',
    name: 'airtable_create_record',
    description: 'Create a record in an Airtable table from a field name/value map.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        table: { type: 'string' },
        fields: { type: 'object', description: 'Field name → value map for the new record.' },
      },
      required: ['baseId', 'table', 'fields'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: airtablePath(str(args.baseId), str(args.table)),
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { fields: (args.fields as Record<string, unknown>) ?? {} },
      }).then((r) => r.data),
  },
  {
    provider: 'airtable',
    name: 'airtable_update_record',
    description: 'Update fields on an existing Airtable record (PATCH leaves unspecified fields as-is).',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        baseId: { type: 'string' },
        table: { type: 'string' },
        recordId: { type: 'string' },
        fields: { type: 'object', description: 'Field name → value map to merge.' },
      },
      required: ['baseId', 'table', 'recordId', 'fields'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'PATCH',
        endpoint: airtablePath(str(args.baseId), str(args.table), str(args.recordId)),
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { fields: (args.fields as Record<string, unknown>) ?? {} },
      }).then((r) => r.data),
  },
]

// ── Figma (REST API v1) ───────────────────────────────────────────────────────
const FIGMA_TOOLS: NangoToolSpec[] = [
  {
    provider: 'figma',
    name: 'figma_get_file',
    description: 'Fetch a Figma file’s document tree and metadata by file key.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string', description: 'File key from the Figma URL (…/file/<key>/…).' },
        depth: { type: 'number', description: 'Optional tree depth to limit the response.' },
      },
      required: ['fileKey'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: `/v1/files/${encodeURIComponent(str(args.fileKey))}`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        ...(num(args.depth, 0) > 0 ? { params: { depth: num(args.depth, 1) } } : {}),
      }).then((r) => r.data),
  },
  {
    provider: 'figma',
    name: 'figma_list_project_files',
    description: 'List the files in a Figma project.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Figma project id.' },
      },
      required: ['projectId'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: `/v1/projects/${encodeURIComponent(str(args.projectId))}/files`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
      }).then((r) => r.data),
  },
  {
    provider: 'figma',
    name: 'figma_get_comments',
    description: 'Read the comments on a Figma file.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
      },
      required: ['fileKey'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'GET',
        endpoint: `/v1/files/${encodeURIComponent(str(args.fileKey))}/comments`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
      }).then((r) => r.data),
  },
  {
    provider: 'figma',
    name: 'figma_post_comment',
    description: 'Post a comment on a Figma file.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        message: { type: 'string', description: 'Comment text.' },
      },
      required: ['fileKey', 'message'],
    },
    run: (connection, args, proxy = defaultProxy()) =>
      proxy({
        method: 'POST',
        endpoint: `/v1/files/${encodeURIComponent(str(args.fileKey))}/comments`,
        connectionId: connection.connectionId,
        providerConfigKey: connection.providerConfigKey,
        data: { message: str(args.message) },
      }).then((r) => r.data),
  },
]

/** Every authored provider tool. */
export const NANGO_PROVIDER_TOOLS: NangoToolSpec[] = [
  ...GITHUB_TOOLS,
  ...LINEAR_TOOLS,
  ...JIRA_TOOLS,
  ...ASANA_TOOLS,
  ...NOTION_TOOLS,
  ...HUBSPOT_TOOLS,
  ...CONFLUENCE_TOOLS,
  ...GDRIVE_TOOLS,
  ...GSHEETS_TOOLS,
  ...MONDAY_TOOLS,
  ...ZENDESK_TOOLS,
  ...SLACK_TOOLS,
  ...SALESFORCE_TOOLS,
  ...GMAIL_READ_TOOLS,
  ...AIRTABLE_TOOLS,
  ...FIGMA_TOOLS,
]

/** Tools for one provider (or [] if none authored yet). */
export function toolsForProvider(provider: string): NangoToolSpec[] {
  return NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === provider)
}

/**
 * Number of agent tools (read + write, including the delivery adapters) wired
 * for a given Nango connection config key. 0 means the provider can be connected
 * in the Nango dashboard but no agent tool will ever resolve that connection —
 * the one thing linking the dashboard catalog to this code registry is exact
 * config-key equality, so this lets the integrations UI and ops see the match.
 */
export const NANGO_TOOL_COUNT_BY_CONFIG_KEY: Record<string, number> = (() => {
  const counts: Record<string, number> = {}
  for (const [provider, keys] of Object.entries(PROVIDER_CONFIG_KEYS)) {
    const n = NANGO_PROVIDER_TOOLS.filter((tool) => tool.provider === provider).length
    for (const key of keys) counts[key] = (counts[key] ?? 0) + n
  }
  for (const tool of DELIVERY_TOOLS) {
    for (const key of DELIVERY_PROVIDERS[tool.capability]) counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
})()

/** Agent-tool count for a Nango config key (0 = connectable but yields no tools). */
export function toolCountForConfigKey(configKey: string): number {
  return NANGO_TOOL_COUNT_BY_CONFIG_KEY[configKey] ?? 0
}

/**
 * Resolve a WRITE tool by its bare name across the provider registry AND the
 * delivery adapters, unified to { provider, run }. The approval executor uses
 * this to run ANY approved Nango write — not just the 3 delivery tools — so the
 * approval gate can safely cover every provider's writes. Read tools and unknown
 * names return null (they must never be executed off an approval). Mirrors the
 * inline plane execution (tool-planes.ts): run(connection, args) with a
 * connection resolved from PROVIDER_CONFIG_KEYS[provider].
 */
export function findNangoWriteTool(
  name: string,
): { provider: string; run: NangoToolSpec['run'] } | null {
  const spec = NANGO_PROVIDER_TOOLS.find((tool) => tool.name === name && tool.isWrite)
  if (spec) return { provider: spec.provider, run: spec.run }
  const delivery = DELIVERY_TOOLS.find((tool) => tool.name === name)
  if (delivery) return { provider: delivery.capability, run: delivery.run }
  return null
}
