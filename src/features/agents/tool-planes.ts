/**
 * Shared tool-plane loaders + executors.
 *
 * An agent draws tools from four planes — People.ai (Sales AI MCP), per-org MCP
 * connections, native built-ins (Granola/Slack/HTTP/Email), and Nango-connected
 * provider tools. These loaders were
 * previously inlined in execute-agent's loadTools; they live here so FLOWS get
 * the exact same tool universe (catalog + execution) without duplicating the
 * gating, scoping, caching, or error-degradation behavior.
 *
 * Each loader returns ToolPlaneGroups: one group per "connection" the flow
 * catalog can surface, carrying the live client the runtime executes against.
 * Loaders degrade gracefully — a failing plane/connection yields an empty
 * group (or none), never a thrown error that would abort a run.
 *
 * Secrets never leave this module: groups expose only ids/names/tool schemas
 * plus an opaque client closure; tokens stay inside the underlying clients.
 */

import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { cacheGet, cacheSet } from '@/lib/cache'
import { BackstoryMcpClient, backstoryMcpConfigured } from '@/lib/mcp/backstory-mcp'
import { getPeopleAiClientForUser, getPeopleAiServiceClient } from '@/lib/peopleai/client'
import { DELIVERY_TOOLS, nangoConfigured, resolveDeliveryConnection, resolveNangoConnection, type DeliveryCapability, type DeliveryConnection } from '@/lib/nango/delivery'
import { NANGO_PROVIDER_TOOLS, PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-tools'
import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { ensureFreshConnectionToken, persistRefreshedAuthcodeTokens } from '@/lib/mcp/connection-token'
import { GranolaToolClient, getGranolaApiKey, granolaTools } from '@/lib/integrations/granola'
import { SlackToolClient, slackTools, getSlackToken } from '@/lib/integrations/slack'
import { HttpToolClient, httpTools } from '@/lib/integrations/http'
import { EmailToolClient, emailTools, getEmailCredential } from '@/lib/integrations/email'
import { BUILTIN_CONNECTORS, isSelected, nangoConnector, type ConnectorDescriptor } from '@/lib/connectors/registry'
import { formatFlowToolConnectionId, type FlowToolPlane } from '@/lib/flows/tool-connection-id'

// Minimal interface every plane's execution client satisfies (McpClient,
// BackstoryMcpClient, the built-in ToolClients, and adapters).
export interface McpToolClient {
  executeTool(serverUrl: string, name: string, args: Record<string, unknown>): Promise<any>
}

export type ToolBinding = {
  provider: string
  serverUrl: string
  toolName: string
  /** Whether this tool writes/delivers outbound — drives the approval gate.
   *  Nango provider tools get one group per tool, so this stays per-tool
   *  accurate rather than collapsing to a per-plane flag. */
  isWrite: boolean
  client: McpToolClient
}

/** A tool as a plane reports it (description already defaulted per plane). */
export type PlaneToolDescriptor = {
  name: string
  description: string
  inputSchema?: unknown
  outputSchema?: unknown
}

/**
 * One "connection" within a plane — a flow-catalog entry plus the live client
 * the runtime executes its tools against. `client` is absent when discovery
 * failed (the group still surfaces as a graceful empty catalog entry).
 */
export type ToolPlaneGroup = {
  /** Flow connection id (see @/lib/flows/tool-connection-id for the scheme). */
  id: string
  plane: FlowToolPlane
  name: string
  /** Runtime binding provider (agent tool naming, audit, approval gating). */
  provider: string
  serverUrl: string
  isWrite: boolean
  client?: McpToolClient
  tools: PlaneToolDescriptor[]
  /**
   * Set when tool discovery FAILED for this connection (token expired, server
   * unreachable, not yet authorized). Distinguishes a real "no actions" from a
   * connection that couldn't be reached, so the builder shows "reconnect"
   * instead of a silent empty list.
   */
  toolsError?: string
}

export function toolName(provider: string, name: string) {
  return `${provider}_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

/** Shared connection visibility: org-shared rows plus the acting user's own. */
export function mcpConnectionScope(organizationId: string, userId?: string) {
  return userId
    ? { organizationId, isActive: true, OR: [{ userId: null }, { userId }] }
    : { organizationId, isActive: true }
}

// MCP tool lists are near-static, but discovery re-ran (initialize + tools/list
// round-trips) on EVERY run. Cache the discovery per server URL so a warm run
// skips the network entirely; busted on connection create/update.
const TOOL_DISCOVERY_TTL_MS = 10 * 60 * 1000
// Keyed by org too: MCP servers can gate tools/list by identity, so one org's
// discovery must not pin another's tool set on a shared serverUrl.
export const toolDiscoveryCacheKey = (organizationId: string, serverUrl: string) => `mcptools:${organizationId}:${serverUrl}`
export async function cachedToolDiscovery<T>(organizationId: string, serverUrl: string, fetchTools: () => Promise<T[]>): Promise<T[]> {
  const key = toolDiscoveryCacheKey(organizationId, serverUrl)
  const hit = await cacheGet<T[]>(key)
  if (hit && hit.length > 0) return hit
  const fresh = await fetchTools()
  // Never cache an empty result — a transient empty/errored discovery must not
  // pin "no tools" for the whole TTL and silently disable the integration.
  if (fresh.length > 0) await cacheSet(key, fresh, TOOL_DISCOVERY_TTL_MS)
  return fresh
}

const EMPTY_SCHEMA = { type: 'object', properties: {} }

/**
 * A plane the agent has ATTACHED but that produced no usable client — the
 * credential is missing, the connection was revoked, or discovery failed.
 *
 * These used to be dropped with a bare `continue`, so an agent whose Gmail
 * connection didn't resolve was indistinguishable from an agent with nothing
 * attached: the run simply had no delivery tool and the model reported it had
 * no tools connected. Emitting a client-less group with `toolsError` keeps the
 * fact reportable — the agent runtime tells the model (and the user) which
 * attached tool is unavailable and why, and the flow catalog already renders
 * `toolsError` as "reconnect".
 */
function unavailableGroup(params: {
  id: string
  plane: FlowToolPlane
  name: string
  provider: string
  isWrite: boolean
  reason: string
}): ToolPlaneGroup {
  const { reason, ...base } = params
  return { ...base, serverUrl: '', tools: [], toolsError: reason }
}

// ── People.ai Sales AI MCP (a.k.a. Backstory MCP) ─────────────────────────────

/**
 * The People.ai / Sales AI plane. Loads whenever a People.ai client resolves —
 * the "connect once, available everywhere" model. Identity order matters for
 * data isolation:
 *  1. The acting OWNER's delegated connection (mcp_* token).
 *  2. The org service key (PAI-Client-Id/Secret) for ownerless runs.
 *  3. Legacy env-configured service account (BACKSTORY_MCP_*), logged loudly
 *     because it is not tenant-isolated.
 * Returns null when nothing resolves (unentitled org) or discovery fails.
 */
export async function loadPeopleAiPlaneGroup(
  organizationId: string,
  ownerUserId?: string | null,
): Promise<ToolPlaneGroup | null> {
  const base = {
    id: formatFlowToolConnectionId('people_ai', 'backstory'),
    plane: 'people_ai' as const,
    name: 'Backstory',
    provider: 'backstory',
    isWrite: false,
  }
  try {
    let paiClient = ownerUserId ? await getPeopleAiClientForUser(ownerUserId, organizationId) : null
    let identity: 'user' | 'service' | 'legacy-env' = 'user'
    if (!paiClient) {
      paiClient = getPeopleAiServiceClient()
      identity = 'service'
    }

    if (paiClient) {
      const adapter: McpToolClient = {
        executeTool: (_serverUrl, name, args) => paiClient!.callTool(name, args),
      }
      if (identity !== 'user') {
        apiLogger.warn('loadTools: People.ai tools using service identity (no owner connection)', {
          organizationId, ownerUserId: ownerUserId ?? null,
        })
      }
      const available = await cachedToolDiscovery(organizationId, paiClient.serverUrl, () => paiClient!.listTools())
      return {
        ...base,
        serverUrl: paiClient.serverUrl,
        client: adapter,
        tools: available.map((tool) => ({
          name: tool.name,
          description: tool.description || `${tool.name} via Backstory`,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : EMPTY_SCHEMA,
        })),
      }
    }
    if (backstoryMcpConfigured()) {
      // A per-user Backstory connection row is the tenant-isolated path (see
      // above); if this owner already has one bound and ready, don't also load
      // the legacy env-wide service account — it would double up tools and,
      // worse, isn't scoped to this org/user.
      const boundUserConnection = ownerUserId
        ? await prisma.mcpConnection.findFirst({
            where: { organizationId, userId: ownerUserId, provider: 'backstory', isActive: true },
            select: { id: true },
          })
        : null
      if (boundUserConnection) {
        apiLogger.info('Backstory MCP bound via per-user connection; env service-account path skipped', {
          organizationId, ownerUserId,
        })
        return null
      }
      // Deprecated: this env-wide service account bypasses per-user/tenant
      // isolation. Prefer the per-user Backstory connection above.
      apiLogger.warn('loadTools: People.ai tools using legacy env service account (no tenant isolation)', {
        organizationId,
      })
      const backstoryUrl = process.env.BACKSTORY_MCP_URL!
      const backstoryClient = new BackstoryMcpClient()
      const available = await cachedToolDiscovery(organizationId, backstoryUrl, () => backstoryClient.getServerTools(backstoryUrl))
      return {
        ...base,
        serverUrl: backstoryUrl,
        client: backstoryClient,
        tools: available.map((tool) => ({
          name: tool.name,
          description: tool.description || `${tool.name} via backstory`,
          inputSchema: tool.inputSchema || EMPTY_SCHEMA,
        })),
      }
    }
    return null
  } catch (error) {
    apiLogger.warn('loadTools: People.ai tool discovery failed, skipping provider', {
      provider: 'backstory',
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Degrade to an empty group (no client) — the agent path skips it exactly
    // as before, while the flow catalog keeps a graceful empty entry so stored
    // graphs don't fail validation over a transient discovery error.
    return { ...base, serverUrl: '', tools: [] }
  }
}

// ── Per-org MCP connections (all active connections, any authType) ────────────

export const mcpConnectionSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/**
 * Per-org custom MCP connections. A failing or unreachable server degrades to
 * an empty group and never aborts the remaining tool planes.
 */
export async function loadMcpConnectionPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { connectionIds?: string[]; take?: number } = {},
): Promise<ToolPlaneGroup[]> {
  const connections = (await prisma.mcpConnection.findMany({
    where: {
      ...mcpConnectionScope(organizationId, ownerUserId ?? undefined),
      ...(options.connectionIds?.length ? { id: { in: options.connectionIds } } : {}),
    },
    ...(options.take ? { take: options.take } : {}),
  }))

  // Discover all org MCP connections in parallel (cached per server URL); token
  // refresh + client build happen per-connection, discovery is cached. Failures
  // degrade to an empty group and are logged.
  return Promise.all(connections.map(async (conn): Promise<ToolPlaneGroup> => {
    const slug = mcpConnectionSlug(conn.name)
    const group: ToolPlaneGroup = {
      id: conn.id, // raw row id — backward compat with stored graphs
      plane: 'mcp',
      name: conn.name,
      provider: slug,
      serverUrl: conn.serverUrl,
      isWrite: false,
      tools: [],
    }
    try {
      const fresh = await ensureFreshConnectionToken(conn)
      const config = mcpConfigFromConnection(fresh)
      // For authcode connections, let a mid-run token refresh persist the
      // rotated tokens back to this row so the next run reuses them.
      if (config.flow === 'authcode') {
        const connectionId = fresh.id
        const baseAuthConfig = fresh.authConfig as Record<string, unknown>
        const fallbackRefresh = config.refreshToken ?? ''
        config.persistTokens = async (tokens) => {
          await persistRefreshedAuthcodeTokens(connectionId, baseAuthConfig, tokens, fallbackRefresh)
        }
      }
      const client = new McpClient(config)
      const available = await cachedToolDiscovery(organizationId, fresh.serverUrl, () => client.getServerTools(fresh.serverUrl))
      group.name = fresh.name
      group.serverUrl = fresh.serverUrl
      group.client = client
      group.tools = available.map((tool) => ({
        name: tool.name,
        description: tool.description || `${tool.name} via ${fresh.name}`,
        inputSchema: tool.inputSchema || EMPTY_SCHEMA,
        outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
      }))
    } catch (error) {
      apiLogger.warn('loadTools: org MCP connection tool discovery failed, skipping', {
        connectionId: conn.id, connectionName: conn.name, serverUrl: conn.serverUrl,
        organizationId, error: error instanceof Error ? error.message : String(error),
      })
      group.toolsError = "Couldn't load this connection's actions — reconnect it and try again."
    }
    return group
  }))
}

// ── Native built-ins (Granola / Slack / HTTP / Email) ─────────────────────────

/**
 * Built-in integration planes. When `providers` is given (the agent path),
 * each plane additionally requires a matching selection; the flow catalog
 * omits it and gates purely on availability. A failure in one plane's setup
 * never blocks the others.
 */
export async function loadNativePlaneGroups(
  organizationId: string,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  const selected = (descriptor: ConnectorDescriptor) =>
    options.providers ? isSelected(descriptor, options.providers) : true
  const groups: ToolPlaneGroup[] = []
  // Only the agent path (which passes `providers`) reports an attached plane as
  // unavailable. The flow catalog gates on availability alone, so flagging every
  // unconfigured builtin there would be noise, not a finding.
  const reportUnavailable = (descriptor: ConnectorDescriptor, reason: string) => {
    if (!options.providers) return
    groups.push(unavailableGroup({
      id: formatFlowToolConnectionId('native', descriptor.providerId),
      plane: 'native',
      name: descriptor.label,
      provider: descriptor.providerId,
      isWrite: descriptor.isWrite,
      reason,
    }))
  }
  const group = (
    descriptor: ConnectorDescriptor,
    serverUrl: string,
    client: McpToolClient,
    defs: { name: string; description: string; inputSchema: Record<string, unknown> }[],
  ): ToolPlaneGroup => ({
    id: formatFlowToolConnectionId('native', descriptor.providerId),
    plane: 'native',
    name: descriptor.label,
    provider: descriptor.providerId,
    serverUrl,
    isWrite: descriptor.isWrite,
    client,
    tools: defs.map((def) => ({ name: def.name, description: def.description, inputSchema: def.inputSchema })),
  })

  // Granola REST API — gated on a per-org key (saved key, then env fallback).
  const granolaConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'granola')!
  if (selected(granolaConn)) {
    try {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (granolaKey) {
        groups.push(group(granolaConn, 'https://public-api.granola.ai/v1', new GranolaToolClient(granolaKey.apiKey), granolaTools()))
      } else {
        reportUnavailable(granolaConn, 'No Granola API key is configured for this workspace — add one in Integrations.')
      }
    } catch (error) {
      apiLogger.warn('loadTools: Granola tool setup failed, skipping provider', {
        provider: 'granola',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      reportUnavailable(granolaConn, 'Granola could not be set up for this run — reconnect it in Integrations.')
    }
  }

  // Slack REST API — gated on a per-org bot token (saved token, then the env
  // fallback for internal/partner orgs only).
  const slackConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'slack')!
  if (selected(slackConn)) {
    try {
      const slackToken = await getSlackToken(organizationId)
      if (slackToken) {
        groups.push(group(slackConn, 'https://slack.com/api', new SlackToolClient(slackToken.value), slackTools()))
      } else {
        reportUnavailable(slackConn, 'No Slack bot token is configured for this workspace — connect Slack in Integrations.')
      }
    } catch (error) {
      apiLogger.warn('loadTools: Slack tool setup failed, skipping provider', {
        provider: 'slack',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      reportUnavailable(slackConn, 'Slack could not be set up for this run — reconnect it in Integrations.')
    }
  }

  // HTTP API — always available; SSRF-guarded in the client. The org is passed
  // so a saved, host-locked credential for the called API is attached
  // automatically instead of living in the agent's instructions.
  const httpConn = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === 'http')!
  if (selected(httpConn)) {
    groups.push(group(httpConn, '', new HttpToolClient(organizationId), httpTools()))
  }

  // Email via Resend REST API — gated on a per-org key, so an agent can only
  // send as its own workspace, never as the shared platform identity.
  const emailConn = BUILTIN_CONNECTORS.find((c) => c.providerId === 'email')!
  if (selected(emailConn)) {
    try {
      const emailKey = await getEmailCredential(organizationId)
      if (emailKey) {
        groups.push(group(emailConn, 'https://api.resend.com', new EmailToolClient(emailKey.value), emailTools()))
      } else {
        reportUnavailable(emailConn, 'No email sending key is configured for this workspace — connect Gmail, or add an email key in Integrations.')
      }
    } catch (error) {
      apiLogger.warn('loadTools: Email tool setup failed, skipping provider', {
        provider: 'email',
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
      reportUnavailable(emailConn, 'Email could not be set up for this run — reconnect it in Integrations.')
    }
  }

  return groups
}

// ── Nango delivery (outbound writes as the acting user) ───────────────────────

/**
 * Nango delivery planes (Slack/Gmail/Salesforce writes as the acting user),
 * one group per capability with a resolvable connection. When `providers` is
 * given (the agent path) a capability additionally requires a matching
 * selection. These are WRITE planes — execution goes through the approval gate.
 */
export async function loadNangoPlaneGroups(
  organizationId: string,
  ownerUserId?: string | null,
  options: { providers?: string[] } = {},
): Promise<ToolPlaneGroup[]> {
  if (!nangoConfigured()) return []
  const groups: ToolPlaneGroup[] = []
  for (const spec of DELIVERY_TOOLS) {
    const connector = nangoConnector(spec.capability)
    if (!connector) continue
    if (options.providers && !isSelected(connector, options.providers)) continue
    try {
      const connection = await resolveDeliveryConnection(organizationId, spec.capability, ownerUserId)
      if (!connection) {
        // Attached but not resolvable. Reported rather than skipped so the run
        // can say "Gmail is attached but no connected account resolved" instead
        // of behaving as though nothing was ever attached.
        if (options.providers) {
          groups.push(unavailableGroup({
            id: formatFlowToolConnectionId('nango', spec.capability),
            plane: 'nango',
            name: connector.label,
            provider: connector.providerId,
            isWrite: connector.isWrite,
            reason: `No connected ${connector.label} account resolved for this workspace — reconnect it in Integrations.`,
          }))
        }
        continue
      }
      const deliveryClient: McpToolClient = {
        executeTool: (_serverUrl, _toolName, args) => spec.run(connection, args),
      }
      groups.push({
        id: formatFlowToolConnectionId('nango', spec.capability),
        plane: 'nango',
        name: connector.label,
        provider: connector.providerId,
        serverUrl: 'nango',
        isWrite: connector.isWrite,
        client: deliveryClient,
        tools: [{ name: spec.name, description: spec.description, inputSchema: spec.inputSchema }],
      })
    } catch (error) {
      apiLogger.warn('loadTools: Nango delivery setup failed, skipping capability', {
        capability: spec.capability,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Multi-provider Nango tools: one group PER TOOL so
  // each carries its own isWrite — read tools (list/search) skip the approval
  // gate, writes (create/update/comment) keep it. Connections resolve once per
  // provider. Selection matches `nango:<provider>` or the bare provider key.
  const connByProvider = new Map<string, DeliveryConnection | null>()
  // One unavailable report per PROVIDER, not per tool — a provider contributes
  // many tools and repeating the same reason for each would bury the signal.
  const reportedUnavailable = new Set<string>()
  for (const tool of NANGO_PROVIDER_TOOLS) {
    if (options.providers && !options.providers.some((p) => p === `nango:${tool.provider}` || p.toLowerCase() === tool.provider)) continue
    try {
      if (!connByProvider.has(tool.provider)) {
        connByProvider.set(tool.provider, await resolveNangoConnection(organizationId, PROVIDER_CONFIG_KEYS[tool.provider] ?? [tool.provider], ownerUserId))
      }
      const connection = connByProvider.get(tool.provider)
      if (!connection) {
        if (options.providers && !reportedUnavailable.has(tool.provider)) {
          reportedUnavailable.add(tool.provider)
          groups.push(unavailableGroup({
            id: formatFlowToolConnectionId('nango', tool.provider),
            plane: 'nango',
            name: providerLabel(tool.provider),
            provider: `nango:${tool.provider}`,
            isWrite: tool.isWrite,
            reason: `No connected ${providerLabel(tool.provider)} account resolved for this workspace — reconnect it in Integrations.`,
          }))
        }
        continue
      }
      groups.push({
        id: formatFlowToolConnectionId('nango', tool.name),
        plane: 'nango',
        name: providerLabel(tool.provider),
        provider: `nango:${tool.provider}`,
        serverUrl: 'nango',
        isWrite: tool.isWrite,
        client: { executeTool: (_serverUrl, _toolName, args) => tool.run(connection, args) },
        tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }],
      })
    } catch (error) {
      apiLogger.warn('loadTools: Nango provider tool setup failed, skipping', {
        provider: tool.provider,
        tool: tool.name,
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return groups
}

/** Plain-English label for a Nango provider key (e.g. 'google_sheets' → 'Google Sheets'). */
function providerLabel(provider: string): string {
  return provider.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── Flow tool-step execution ──────────────────────────────────────────────────

export type FlowToolExecutor = {
  /** Runtime provider id (approval gating via capabilityFromProvider, audit). */
  provider: string
  isWrite: boolean
  execute: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Resolve the executor for a flow tool step from its parsed connection id.
 * Mirrors how the agent runtime binds each plane's calls; throws a
 * user-actionable error when the referenced connection no longer resolves.
 */
export async function resolveFlowToolExecutor(params: {
  organizationId: string
  userId: string
  plane: FlowToolPlane
  ref: string
  toolName: string
}): Promise<FlowToolExecutor> {
  const { organizationId, userId, plane, ref } = params

  if (plane === 'mcp') {
    const conn = await prisma.mcpConnection.findFirst({
      // Match catalog visibility exactly: an org-shared connection or one
      // owned by the acting user. A stored/crafted graph must not be able to
      // execute another member's personal MCP credentials.
      where: { id: ref, ...mcpConnectionScope(organizationId, userId) },
    })
    if (!conn) throw new Error('The selected connection no longer exists — pick another in the step config.')
    const fresh = await ensureFreshConnectionToken(conn)
    const client = new McpClient(mcpConfigFromConnection(fresh))
    return {
      provider: mcpConnectionSlug(fresh.name),
      isWrite: false,
      execute: (name, args) => client.executeTool(fresh.serverUrl, name, args),
    }
  }

  if (plane === 'people_ai') {
    // Same identity ladder as the agent runtime: acting user's delegated
    // connection, then the org service key, then the legacy env service account.
    const paiClient = (await getPeopleAiClientForUser(userId, organizationId)) ?? getPeopleAiServiceClient()
    if (paiClient) {
      return { provider: 'backstory', isWrite: false, execute: (name, args) => paiClient.callTool(name, args) }
    }
    if (backstoryMcpConfigured()) {
      const backstoryUrl = process.env.BACKSTORY_MCP_URL!
      const client = new BackstoryMcpClient()
      return { provider: 'backstory', isWrite: false, execute: (name, args) => client.executeTool(backstoryUrl, name, args) }
    }
    throw new Error('People.ai tools are not available for this workspace — connect People.ai first.')
  }

  if (plane === 'native') {
    if (ref === 'granola') {
      const granolaKey = await getGranolaApiKey(organizationId)
      if (!granolaKey) throw new Error('Granola is not configured for this workspace.')
      const client = new GranolaToolClient(granolaKey.apiKey)
      return { provider: 'granola', isWrite: false, execute: (name, args) => client.executeTool('', name, args) }
    }
    if (ref === 'slack' || ref === 'email' || ref === 'http') {
      const descriptor = BUILTIN_CONNECTORS.find((c) => c.kind === 'builtin' && c.providerId === ref)!
      // Slack and Email resolve a per-workspace credential; a customer org
      // without one simply doesn't have the integration. HTTP needs none.
      let client: McpToolClient
      if (ref === 'slack') {
        const token = await getSlackToken(organizationId)
        if (!token) throw new Error(`${descriptor.label} is not configured for this workspace.`)
        client = new SlackToolClient(token.value)
      } else if (ref === 'email') {
        const key = await getEmailCredential(organizationId)
        if (!key) throw new Error(`${descriptor.label} is not configured for this workspace.`)
        client = new EmailToolClient(key.value)
      } else {
        client = new HttpToolClient(organizationId)
      }
      return { provider: ref, isWrite: descriptor.isWrite, execute: (name, args) => client.executeTool('', name, args) }
    }
    throw new Error(`Unknown built-in integration "${ref}" — pick another in the step config.`)
  }

  // nango — connected provider tools, with per-tool write classification.
  if (!nangoConfigured()) throw new Error('Integrations are not configured for this workspace.')
  const providerTool = NANGO_PROVIDER_TOOLS.find((tool) => tool.name === ref)
  if (providerTool) {
    const connection = await resolveNangoConnection(
      organizationId,
      PROVIDER_CONFIG_KEYS[providerTool.provider] ?? [providerTool.provider],
      userId,
    )
    if (!connection) throw new Error(`No connected ${providerLabel(providerTool.provider)} account is available — connect one in Integrations.`)
    return {
      provider: `nango:${providerTool.provider}`,
      isWrite: providerTool.isWrite,
      execute: (name, args) => {
        if (name !== providerTool.name) throw new Error(`Tool "${name}" is not available on this connection.`)
        return providerTool.run(connection, args)
      },
    }
  }

  const spec = DELIVERY_TOOLS.find((tool) => tool.capability === (ref as DeliveryCapability))
  if (!spec) throw new Error(`Unknown Nango tool "${ref}" — pick another in the step config.`)
  const connection = await resolveDeliveryConnection(organizationId, spec.capability, userId)
  if (!connection) throw new Error(`No connected ${spec.capability} account is available — connect one in Integrations.`)
  return {
    provider: `nango:${spec.capability}`,
    isWrite: true,
    execute: (name, args) => {
      if (name !== spec.name) throw new Error(`Tool "${name}" is not available on this connection.`)
      return spec.run(connection, args)
    },
  }
}
