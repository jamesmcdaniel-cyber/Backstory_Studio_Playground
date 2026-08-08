/**
 * Per-tool quick configuration for an agent's connected tools.
 *
 * Some connectors expose a natural resource scope — Slack has channels, GitHub
 * has repositories — and an agent should be attachable to a subset of them, not
 * the whole account. Each descriptor here powers the gear popover on the
 * agent-config chip row: where to fetch the live options from (via the same
 * read-only POST /api/flows/tool-options endpoint the flow builder's resource
 * picker uses), how to normalize an item into an option, and the copy.
 *
 * The chosen options persist as `AgentTask.metadata.toolSettings`, keyed by the
 * descriptor key. An empty/missing list means unrestricted — the same "empty =
 * all" sentinel the subagent and flow pickers use. At run time the selection is
 * enforced twice: appended to the tool descriptions the model sees, and as a
 * hard guard on the call arguments before execution (toolScopeViolation).
 *
 * Pure data + pure functions: imported by both the client form and the server
 * runtime, so nothing here may touch prisma/env/node APIs.
 */

export type ToolScopeOption = { id: string; label: string }

/** metadata.toolSettings — keyed by quick-config key; empty array = unrestricted. */
export type AgentToolSettings = Record<string, ToolScopeOption[]>

export type ToolQuickConfig = {
  /** Canonical key: matches chip keys and runtime provider ids by substring. */
  key: string
  noun: string
  nounPlural: string
  title: string
  description: string
  /** Request body for POST /api/flows/tool-options (a read-only tool run). */
  optionsRequest?: {
    connectionId: string
    toolName: string
    args?: Record<string, unknown>
    itemsPath?: string
  }
  /** GET endpoint returning { success, items } — used instead of optionsRequest. */
  optionsUrl?: string
  /** Normalize one fetched item into an option; null skips the item. */
  mapItem: (item: unknown) => ToolScopeOption | null
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export const TOOL_QUICK_CONFIGS: ToolQuickConfig[] = [
  {
    key: 'slack',
    noun: 'channel',
    nounPlural: 'channels',
    title: 'Slack channels',
    description: 'Limit which channels this agent can read from and post to.',
    // itemsPath is required: Slack wraps the list as {ok, channels: [...]},
    // which the generic pageItems auto-detection does not unwrap.
    optionsRequest: { connectionId: 'nango:slack_list_channels', toolName: 'slack_list_channels', itemsPath: 'channels' },
    mapItem: (item) => {
      const row = record(item)
      const id = typeof row?.id === 'string' ? row.id : ''
      const name = typeof row?.name === 'string' ? row.name : ''
      return id && name ? { id, label: `#${name}` } : null
    },
  },
  {
    key: 'github',
    noun: 'repository',
    nounPlural: 'repositories',
    title: 'GitHub repositories',
    description: 'Limit which repositories this agent can work with.',
    optionsRequest: { connectionId: 'nango:github_list_repositories', toolName: 'github_list_repositories', args: { per_page: 100 } },
    mapItem: (item) => {
      const row = record(item)
      const fullName = typeof row?.full_name === 'string' ? row.full_name : ''
      return fullName ? { id: fullName, label: fullName } : null
    },
  },
]

/**
 * MCP connections get the same gear popover, but per CONNECTION rather than per
 * static descriptor: the options are the server's own tools (via
 * GET /api/mcp-connections/[id]/tools), and the setting means "which tools this
 * agent may use" rather than a resource scope. Keyed `mcp:<connectionId>` so a
 * renamed server keeps its setting and two servers never collide — connection
 * NAMES are the selection keys elsewhere, ids are the stable handle.
 */
export const mcpQuickConfigKey = (connectionId: string) => `mcp:${connectionId}`

export function mcpToolQuickConfig(connection: { id: string; name: string }): ToolQuickConfig {
  return {
    key: mcpQuickConfigKey(connection.id),
    noun: 'tool',
    nounPlural: 'tools',
    title: `${connection.name} tools`,
    description: 'Choose which of this server’s tools the agent can use.',
    optionsUrl: `/api/mcp-connections/${connection.id}/tools`,
    mapItem: (item) => {
      const row = record(item)
      const name = typeof row?.name === 'string' ? row.name.trim() : ''
      return name ? { id: name, label: name } : null
    },
  }
}

/**
 * The tool-name allowlist for an MCP connection, or null when unrestricted
 * (no entry / empty = all tools — the same sentinel as resource scopes).
 */
export function mcpAllowedToolNames(settings: AgentToolSettings, connectionId: string): Set<string> | null {
  const options = scopedOptions(settings, mcpQuickConfigKey(connectionId))
  if (options.length === 0) return null
  return new Set(options.map((option) => option.id))
}

/** The quick config a connected-tools chip offers, if any. */
export function quickConfigForChip(chipKey: string): ToolQuickConfig | undefined {
  const key = chipKey.toLowerCase()
  return TOOL_QUICK_CONFIGS.find((config) => key.includes(config.key))
}

/** The quick config governing a runtime provider id ('slack', 'nango:slack', 'nango:github'). */
export function quickConfigForProvider(providerId: string): ToolQuickConfig | undefined {
  const key = providerId.toLowerCase()
  return TOOL_QUICK_CONFIGS.find((config) => key.includes(config.key))
}

const SCOPE_OPTION_CAP = 200

/** Parse the metadata.toolSettings JSON into a typed shape (never throws). */
export function parseAgentToolSettings(value: unknown): AgentToolSettings {
  const raw = record(value)
  if (!raw) return {}
  const settings: AgentToolSettings = {}
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue
    const options: ToolScopeOption[] = []
    for (const entry of list) {
      const row = record(entry)
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      const label = typeof row?.label === 'string' ? row.label.trim() : ''
      if (id) options.push({ id, label: label || id })
      if (options.length >= SCOPE_OPTION_CAP) break
    }
    settings[key] = options
  }
  return settings
}

/** The restriction list for a quick-config key; empty = unrestricted. */
export function scopedOptions(settings: AgentToolSettings, key: string): ToolScopeOption[] {
  return settings[key] ?? []
}

/** Chip badge copy: 'All channels' or '3 channels'. */
export function scopeSummary(config: ToolQuickConfig, options: ToolScopeOption[]): string {
  if (options.length === 0) return `All ${config.nounPlural}`
  return `${options.length} ${options.length === 1 ? config.noun : config.nounPlural}`
}

const formatOptions = (options: ToolScopeOption[]) =>
  options.map((option) => (option.label === option.id ? option.label : `${option.label} (${option.id})`)).join(', ')

/**
 * Scope sentence appended to every tool description of a restricted provider,
 * so the model targets permitted values instead of discovering the guard by
 * being blocked.
 */
export function scopeDescriptionSuffix(providerId: string, settings: AgentToolSettings): string | null {
  const config = quickConfigForProvider(providerId)
  if (!config) return null
  const options = scopedOptions(settings, config.key)
  if (options.length === 0) return null
  return `Scope: this agent is limited to these ${config.title}: ${formatOptions(options)}. Calls outside this list are blocked.`
}

/** '#general ' / 'general' / '#General' all name the same channel. */
const normalizeChannelName = (value: string) => value.trim().replace(/^#/, '').toLowerCase()

function slackChannelAllowed(value: string, options: ToolScopeOption[]): boolean {
  const id = value.trim().toLowerCase()
  const name = normalizeChannelName(value)
  return options.some(
    (option) => option.id.toLowerCase() === id || normalizeChannelName(option.label) === name,
  )
}

/**
 * Hard guard: does this tool call violate the agent's per-tool scope?
 * Returns the block message to surface to the model, or null when allowed.
 *
 * Arg-shape driven rather than tool-name driven, so every current and future
 * tool of a provider is covered: any Slack call carrying a `channel` and any
 * GitHub call carrying `owner` + `repo` is checked. Calls without the scoped
 * argument (e.g. slack_search_messages, github_list_repositories) pass — they
 * target the account, not a specific resource.
 */
export function toolScopeViolation(params: {
  provider: string
  toolName: string
  args: unknown
  settings: AgentToolSettings
}): string | null {
  const config = quickConfigForProvider(params.provider)
  if (!config) return null
  const options = scopedOptions(params.settings, config.key)
  if (options.length === 0) return null
  const args = record(params.args)
  if (!args) return null

  if (config.key === 'slack') {
    const channel = typeof args.channel === 'string' ? args.channel : ''
    if (!channel || slackChannelAllowed(channel, options)) return null
    return `Blocked: this agent is limited to these Slack channels: ${formatOptions(options)} — "${channel}" is not one of them. Use an allowed channel, or update the agent's Slack settings.`
  }

  if (config.key === 'github') {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : ''
    const repo = typeof args.repo === 'string' ? args.repo.trim() : ''
    if (!owner || !repo) return null
    const target = `${owner}/${repo}`.toLowerCase()
    if (options.some((option) => option.id.toLowerCase() === target)) return null
    return `Blocked: this agent is limited to these GitHub repositories: ${formatOptions(options)} — "${owner}/${repo}" is not one of them. Use an allowed repository, or update the agent's GitHub settings.`
  }

  return null
}
