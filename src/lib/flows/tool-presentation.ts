import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

export type PresentableTool = {
  name: string
  description: string
  inputSchema?: unknown
  outputSchema?: unknown
}

export type PresentableConnection = {
  id: string
  name: string
  tools: PresentableTool[]
  toolsError?: string
}

export type ToolBrand = {
  /** Stable grouping key. Custom MCP connections intentionally remain unique. */
  key: string
  label: string
  /** IntegrationLogo slug. */
  slug: string
}

const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Provider identity matchers, shared by connection-brand resolution and the
 * connectionless step fallback (unbound imports, branded HTTP endpoints). */
const KNOWN_BRANDS: { match: RegExp; key: string; label: string; slug: string }[] = [
  { match: /google[\s_-]*sheets?/, key: 'google_sheets', label: 'Google Sheets', slug: 'googlesheets' },
  { match: /google[\s_-]*drive/, key: 'google_drive', label: 'Google Drive', slug: 'googledrive' },
  { match: /google[\s_-]*mail|gmail/, key: 'gmail', label: 'Gmail', slug: 'gmail' },
  { match: /salesforce/, key: 'salesforce', label: 'Salesforce', slug: 'salesforce' },
  { match: /backstory|people[\s_.-]*ai/, key: 'backstory', label: 'Backstory', slug: 'backstory' },
  { match: /slack/, key: 'slack', label: 'Slack', slug: 'slack' },
  { match: /snowflake/, key: 'snowflake', label: 'Snowflake', slug: 'snowflake' },
  { match: /granola/, key: 'granola', label: 'Granola', slug: 'granola' },
  { match: /monday/, key: 'monday', label: 'Monday', slug: 'mondaydotcom' },
  { match: /github/, key: 'github', label: 'GitHub', slug: 'github' },
  { match: /linear/, key: 'linear', label: 'Linear', slug: 'linear' },
  { match: /jira|atlassian/, key: 'jira', label: 'Jira', slug: 'jira' },
  { match: /confluence/, key: 'confluence', label: 'Confluence', slug: 'confluence' },
  { match: /notion/, key: 'notion', label: 'Notion', slug: 'notion' },
  { match: /hubspot|hubapi/, key: 'hubspot', label: 'HubSpot', slug: 'hubspot' },
  { match: /zendesk/, key: 'zendesk', label: 'Zendesk', slug: 'zendesk' },
  { match: /airtable/, key: 'airtable', label: 'Airtable', slug: 'airtable' },
  { match: /figma/, key: 'figma', label: 'Figma', slug: 'figma' },
  { match: /asana/, key: 'asana', label: 'Asana', slug: 'asana' },
  { match: /apollo/, key: 'apollo', label: 'Apollo', slug: 'apollo' },
  { match: /http/, key: 'http', label: 'HTTP API', slug: 'http' },
  { match: /email|resend|smtp/, key: 'email', label: 'Email', slug: 'resend' },
]

/** Match free text (a tool name, an importer note, a URL) to a provider brand. */
export function matchBrandHint(hint: string): ToolBrand | null {
  const lowered = hint.toLowerCase()
  const match = KNOWN_BRANDS.find((entry) => entry.match.test(lowered))
  return match ? { key: match.key, label: match.label, slug: match.slug } : null
}

/**
 * Brand for a step that has NO resolvable catalog connection — an imported
 * tool step awaiting its connection pick, or an HTTP step aimed at a known
 * provider's API. Company logos on the canvas beat generic wrench/globe
 * icons: the flow reads as "Slack → Snowflake → Gmail" at a glance.
 */
export function stepBrandFallback(node: {
  type: string
  data: Record<string, unknown>
}): ToolBrand | null {
  if (node.type === 'tool') {
    const hint = `${String(node.data.toolName ?? '')} ${String(node.data.label ?? '')} ${String(node.data.note ?? '')}`
    const brand = matchBrandHint(hint)
    // 'http' matching a tool name like "http_request" is not a brand worth
    // showing over the tool tile; only real providers upgrade the icon.
    return brand && brand.key !== 'http' ? brand : null
  }
  if (node.type === 'http') {
    const url = String(node.data.url ?? '')
    const host = url.match(/^[a-z]+:\/\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? ''
    if (!host) return null
    const HOST_BRANDS: { match: RegExp; hint: string }[] = [
      { match: /(^|\.)slack\.com$/, hint: 'slack' },
      { match: /\.snowflakecomputing\.com$/, hint: 'snowflake' },
      { match: /^gmail\.googleapis\.com$/, hint: 'gmail' },
      { match: /^sheets\.googleapis\.com$/, hint: 'google sheets' },
      { match: /^(www\.)?googleapis\.com$/, hint: url.includes('/drive') ? 'google drive' : url.includes('/gmail') ? 'gmail' : url.includes('/spreadsheets') ? 'google sheets' : '' },
      { match: /(^|\.)github\.com$/, hint: 'github' },
      { match: /\.atlassian\.net$/, hint: url.includes('/wiki') ? 'confluence' : 'jira' },
      { match: /(^|\.)notion\.com$|(^|\.)notion\.so$/, hint: 'notion' },
      { match: /(^|\.)linear\.app$/, hint: 'linear' },
      { match: /(^|\.)airtable\.com$/, hint: 'airtable' },
      { match: /(^|\.)hubapi\.com$/, hint: 'hubspot' },
      { match: /\.zendesk\.com$/, hint: 'zendesk' },
      { match: /\.salesforce\.com$|\.force\.com$/, hint: 'salesforce' },
      { match: /(^|\.)figma\.com$/, hint: 'figma' },
      { match: /(^|\.)asana\.com$/, hint: 'asana' },
      { match: /(^|\.)monday\.com$/, hint: 'monday' },
      { match: /(^|\.)resend\.com$/, hint: 'email' },
      { match: /(^|\.)people\.ai$/, hint: 'people.ai' },
      { match: /(^|\.)granola\.ai$/, hint: 'granola' },
    ]
    const entry = HOST_BRANDS.find((candidate) => candidate.match.test(host))
    return entry?.hint ? matchBrandHint(entry.hint) : null
  }
  return null
}

/**
 * Resolve the user-facing provider behind a catalog connection.
 *
 * Nango exposes some providers as one synthetic connection per action
 * (`nango:slack_user_post_message`, etc.). The connection id is therefore not
 * a logo slug and must not be used as the provider identity. The catalog name
 * is the stable provider signal for those rows.
 */
export function toolConnectionBrand(connection: PresentableConnection): ToolBrand {
  const { plane, ref } = parseFlowToolConnectionId(connection.id)
  if (plane === 'mcp') {
    const slug = normalized(connection.name)
    return {
      key: `mcp:${connection.id}`,
      label: connection.name,
      slug: slug.includes('backstory') ? 'backstory' : slug,
    }
  }
  if (plane === 'people_ai') return { key: 'backstory', label: 'Backstory', slug: 'backstory' }

  const match = matchBrandHint(`${connection.name} ${ref}`)
  const fallback = normalized(connection.name || ref) || 'integration'
  return match ?? { key: fallback, label: connection.name || ref, slug: fallback }
}

export function toolConnectionsForBrand(
  catalog: PresentableConnection[],
  connection: PresentableConnection,
): PresentableConnection[] {
  const key = toolConnectionBrand(connection).key
  return catalog.filter((entry) => toolConnectionBrand(entry).key === key)
}

export type ToolActionChoice = {
  key: string
  connectionId: string
  tool: PresentableTool
  label: string
}

export function toolActionChoices(
  catalog: PresentableConnection[],
  connection: PresentableConnection,
): ToolActionChoice[] {
  const brand = toolConnectionBrand(connection)
  return toolConnectionsForBrand(catalog, connection).flatMap((entry) =>
    entry.tools.map((tool) => ({
      key: `${encodeURIComponent(entry.id)}::${encodeURIComponent(tool.name)}`,
      connectionId: entry.id,
      tool,
      label: humanizeToolName(tool.name, brand.slug),
    })),
  )
}

export function selectedToolPresentation(
  catalog: PresentableConnection[],
  connectionId: string,
  toolName: string,
) {
  const connection = catalog.find((entry) => entry.id === connectionId)
  const tool = connection?.tools.find((entry) => entry.name === toolName)
  const brand = connection ? toolConnectionBrand(connection) : null
  return {
    connection,
    tool,
    brand,
    actionLabel: tool && brand ? humanizeToolName(tool.name, brand.slug) : '',
  }
}

/** One row per provider for the picker; each row retains its concrete actions. */
export function groupToolConnections(catalog: PresentableConnection[]) {
  const groups = new Map<string, { brand: ToolBrand; connections: PresentableConnection[] }>()
  for (const connection of catalog) {
    const brand = toolConnectionBrand(connection)
    const existing = groups.get(brand.key)
    if (existing) existing.connections.push(connection)
    else groups.set(brand.key, { brand, connections: [connection] })
  }
  return Array.from(groups.values())
}
