import { prisma } from '@/lib/prisma'
import { granolaConfigured, getGranolaApiKey } from '@/lib/integrations/granola'
import { slackConfigured, getSlackToken } from '@/lib/integrations/slack'
import {
  BUILTIN_CONNECTORS,
  fromNangoProviderKey,
} from '@/lib/connectors/registry'

/**
 * Single source of "connected" across the org's integration planes.
 *
 * The integration-plane merge that /api/integrations/available renders lived inline in
 * that route; it now lives here so the create-agent picker AND the auto-template
 * gate agree on what "connected" means. Both projections read the SAME planes:
 *  - `getAvailableIntegrations` reproduces the route's payload byte-for-byte
 *    (every attachable tool, connected or not, plus custom connections).
 *  - `listConnectedProviders` returns just the providers the ORG has actually
 *    connected — the input the ≥3-integration template gate counts.
 */

export type ToolChip = { key: string; label: string; slug: string; connected: boolean }

export type AvailableIntegrations = {
  tools: ToolChip[]
  connections: { id: string; name: string }[]
}

// Raw per-plane reads, done once so both projections stay in lockstep. All
// reads are org-scoped (the tenant-guard invariant); Granola is read separately
// per projection because the two need different definitions of it (see below).
type PlaneReads = {
  connectionsRaw: { id: string; name: string; serverUrl: string }[]
  nango: { providerConfigKey: string }[]
}

async function readPlanes(organizationId: string): Promise<PlaneReads> {
  const [connectionsRaw, nango] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true, serverUrl: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.nangoConnection.findMany({
      where: { organizationId, status: 'connected' },
      select: { providerConfigKey: true },
    }),
  ])
  return { connectionsRaw, nango }
}

/**
 * The /api/integrations/available payload: every tool the org can attach, merged
 * across planes with a per-tool `connected` flag. Extracted verbatim from the
 * route so its response stays byte-identical — the route just spreads this under
 * `success: true`.
 */
export async function getAvailableIntegrations(organizationId: string): Promise<AvailableIntegrations> {
  const [{ connectionsRaw, nango }, hasGranola, hasSlack] = await Promise.all([
    readPlanes(organizationId),
    granolaConfigured(organizationId),
    slackConfigured(organizationId),
  ])

  // Builtins whose availability is per-WORKSPACE (their own credential, or the
  // env fallback where the org kind allows it) rather than a global env check.
  const perOrgConnected: Record<string, boolean> = { Granola: hasGranola, Slack: hasSlack }

  // Merge planes, deduping by lowercased key and OR-ing connected state. Builtins
  // are added first so their canonical labels/keys (Slack/Email/Granola) win.
  const byKey = new Map<string, ToolChip>()
  const add = (chip: ToolChip) => {
    const id = chip.key.toLowerCase()
    const existing = byKey.get(id)
    if (existing) existing.connected = existing.connected || chip.connected
    else byKey.set(id, chip)
  }

  // Built-in delivery/meeting planes, straight from the registry. Granola and
  // Slack resolve per-org (a workspace credential); the rest — HTTP, Backstory —
  // are always-on platform capabilities and answer via available().
  for (const c of BUILTIN_CONNECTORS) {
    if (c.kind !== 'builtin') continue
    // Resend email is redundant with Gmail delivery, so it's retired from the
    // picker. The registry entry stays so the runtime email plane still works
    // for any agent that already has it selected.
    if (c.providerId === 'email') continue
    add({ key: c.key, label: c.label, slug: c.slug, connected: perOrgConnected[c.key] ?? c.available() })
  }

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    add({ ...m, connected: true })
  }

  // Connected first, then alphabetical, so the user's real tools lead.
  const tools = [...byKey.values()].sort((a, b) =>
    a.connected === b.connected ? a.label.localeCompare(b.label) : a.connected ? -1 : 1,
  )

  return { tools, connections: connectionsRaw.map((c) => ({ id: c.id, name: c.name })) }
}

export type ConnectedPlane = 'nango' | 'mcp' | 'builtin'
export type ConnectedProvider = { key: string; label: string; plane: ConnectedPlane }

/**
 * Every provider the ORG has actually connected — the input the template gate
 * counts. One entry is returned per connected plane.
 *
 * Distinct-provider KEY = the lowercased registry key
 * fromNangoProviderKey, the SAME dedupe key /api/integrations/available uses.
 * Custom MCP connections get plane-prefixed keys (`mcp:<id>`) because each
 * configured server is its own integration and must not collide with a provider slug.
 *
 * This is the CONNECTED subset of getAvailableIntegrations, and deliberately
 * NARROWER than "every chip whose `connected` flag is true": the always-on
 * platform builtins (HTTP API, Backstory) and env-configured Slack/Email are
 * capabilities every org has, not integrations THIS org connected — counting
 * them would inflate every org past the gate and make the number env-dependent.
 * Granola is the one builtin that counts, and only via a per-ORG API key that
 * actually RESOLVES — getGranolaApiKey with source 'org' (an active
 * integration_secret whose apiKey DECRYPTS). This matches /api/integrations/
 * available's decryptable-key definition (granolaConfigured), so a dead
 * (undecryptable) key no longer holds an org past the gate; and it still excludes
 * the GRANOLA_API_KEY env fallback (source 'env'), which is platform-level.
 *
 * Org-scoped exactly like /api/integrations/available (all of the org's
 * connections, not just this user's). `_userId` is accepted for signature parity
 * with the user-scoped plane; the connected planes are org-visible today.
 */
export async function listConnectedProviders(
  organizationId: string,
  _userId: string,
): Promise<ConnectedProvider[]> {
  const [{ connectionsRaw, nango }, granolaKey, slackToken] = await Promise.all([
    readPlanes(organizationId),
    getGranolaApiKey(organizationId),
    getSlackToken(organizationId),
  ])

  const providers: ConnectedProvider[] = []

  for (const c of nango) {
    const m = fromNangoProviderKey(c.providerConfigKey)
    providers.push({ key: m.key.toLowerCase(), label: m.label, plane: 'nango' })
  }
  // Custom MCP connections — each configured server is its own
  // integration, keyed by id so two distinct servers never collapse.
  for (const c of connectionsRaw) {
    providers.push({ key: `mcp:${c.id.toLowerCase()}`, label: c.name, plane: 'mcp' })
  }
  if (granolaKey?.source === 'org') {
    providers.push({ key: 'granola', label: 'Granola', plane: 'builtin' })
  }
  // Slack counts on the same terms as Granola, and for the same reason: a
  // workspace's OWN bot token is an integration this org connected. The env
  // fallback (source 'env') still doesn't count — it's a platform capability,
  // and counting it would inflate every eligible org past the template gate.
  if (slackToken?.source === 'org') {
    providers.push({ key: 'slack', label: 'Slack', plane: 'builtin' })
  }

  return providers
}
