import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { summarizeConnectedIntegrations } from '@/lib/integrations/integration-count'

/**
 * Turning an accepted recommendation into a LIVE, ready-to-run artifact — the
 * 1-click provisioning path. An agent_template proposal's config becomes an
 * ACTIVE AgentTask (instructions, integrations, and the PROPOSED cadence), with
 * its integration selection projected into typed connector bindings so the very
 * next run resolves them. Pure-ish over the config; the DB writes are contained.
 */

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' && v.trim() ? v : fallback)
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))] : []

const ACTIVE_SCHEDULE_TYPES = new Set(['hourly', 'daily', 'weekly', 'cron'])

/**
 * A proposal's string cadence ('daily'/'weekly'/…) → an ACTIVE agent schedule.
 * A recommended "weekly digest" must land as a weekly, active agent — not the
 * manual, inactive default the old template→instantiate path hardcoded.
 */
export function scheduleFromCadence(cadence: unknown): { type: string; timezone: string; isActive: boolean } {
  const type = typeof cadence === 'string' && ACTIVE_SCHEDULE_TYPES.has(cadence) ? cadence : 'manual'
  return { type, timezone: 'UTC', isActive: type !== 'manual' }
}

/** Referenced integrations that the org/user has NOT connected yet (lowercased match). */
export async function missingIntegrations(
  organizationId: string,
  userId: string,
  referenced: string[],
): Promise<string[]> {
  if (referenced.length === 0) return []
  const connected = new Set(
    (await summarizeConnectedIntegrations(organizationId, userId)).providers.map((p) => p.key.toLowerCase()),
  )
  return [...new Set(referenced.map((r) => r.toLowerCase()))].filter((r) => !connected.has(r))
}

/**
 * Create a live agent from an agent_template proposal's `configuration` blob
 * ({ name, instructions, integrations, model, schedule? }). Returns the agent
 * plus the referenced integrations that are not yet connected (the caller can
 * prompt the user to connect them; the agent is still created so it's ready the
 * moment they are).
 */
export async function provisionAgentFromConfig(
  organizationId: string,
  userId: string,
  configuration: unknown,
  fallbackTitle: string,
  /** The template this agent came from, stamped so a re-accept can find it. */
  templateId?: string,
): Promise<{ agent: AgentTask; missing: string[] }> {
  const config = asObject(configuration)
  const title = str(config.name, fallbackTitle)
  const integrations = strArray(config.integrations)
  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent',
      agentType: 'CUSTOM',
      priority: 'MEDIUM',
      description: str(config.description, title),
      objective: str(config.instructions, title),
      context: {},
      schedule: scheduleFromCadence(config.schedule),
      status: 'ACTIVE',
      visibility: 'shared',
      organizationId,
      userId,
      metadata: {
        title,
        description: str(config.description),
        model: str(config.model, DEFAULT_AGENT_MODEL),
        integrations,
        skills: [],
        icon: '',
        ...(templateId ? { templateId } : {}),
      },
    },
  })
  // Project the selection into typed connector bindings (await: a fresh agent
  // has no rows, so its first run must see them, not the fallback path).
  await syncAgentConnectors(agent.id, organizationId, integrations)
  const missing = await missingIntegrations(organizationId, userId, integrations)
  return { agent, missing }
}

/**
 * The live agent a template already provisioned, if any (matched on the
 * `templateId` stamped into its metadata at provision time).
 *
 * Accepting a recommendation is idempotent — a second Apply must still LAND the
 * user on the agent the first one built, instead of returning a bare template id
 * that no surface knows how to open.
 */
export async function findAgentFromTemplate(
  organizationId: string,
  templateId: string,
): Promise<AgentTask | null> {
  return prisma.agentTask.findFirst({
    where: {
      organizationId,
      status: { not: 'DELETED' },
      metadata: { path: ['templateId'], equals: templateId },
    },
    orderBy: { createdAt: 'asc' },
  })
}
