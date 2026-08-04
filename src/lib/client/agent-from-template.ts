'use client'

import { getSnapshot } from './snapshot'

/** The fields a template contributes to a brand-new agent. */
export type AgentTemplateSource = {
  name: string
  description: string
  instructions: string
  integrations: string[]
  skills?: string[]
  model: string
  icon?: string
  allowSubagents?: boolean
}

export type CreateFromTemplateResult =
  | { ok: true; href: string }
  | { ok: false; error: string }

/** Deep link that opens one agent in Agent HQ. */
export function agentHref(agentId: string): string {
  return `/agents?agent=${encodeURIComponent(agentId)}`
}

/**
 * Create an agent from a template and return where to send the user.
 *
 * The destination is always Agent HQ — the new agent when the API named it, the
 * list otherwise. Never the home page: Agent HQ used to live at /dashboard, and
 * a create that still pushed there dropped people on the Assistant with no sign
 * of the agent it had just built.
 *
 * The forced snapshot refresh is load-bearing, not hygiene. Agent HQ hydrates
 * from the shared snapshot cache and silently drops an ?agent= deep link naming
 * an agent that cache doesn't hold yet, so a copy warmed seconds ago would land
 * the user on some other agent.
 */
export async function createAgentFromTemplate(template: AgentTemplateSource): Promise<CreateFromTemplateResult> {
  const response = await fetch('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: template.name,
      description: template.description,
      instructions: template.instructions,
      integrations: template.integrations,
      skills: template.skills || [],
      model: template.model,
      icon: template.icon || '',
      allowSubagents: template.allowSubagents === true,
      // Manual by default: connecting a template must never silently start a
      // recurring job on the user's behalf.
      schedule: { type: 'manual', timezone: 'UTC', isActive: false },
    }),
  })
  const data = (await response.json().catch(() => ({}))) as { agent?: { id?: unknown }; error?: string }
  if (!response.ok) {
    return { ok: false, error: data.error || 'Could not create the agent. Please try again.' }
  }
  const agentId = typeof data.agent?.id === 'string' ? data.agent.id : null
  // Awaited: the destination reads this cache on mount, so it has to hold the
  // new agent before we navigate. A failed refresh only costs the deep link.
  await getSnapshot(0).catch(() => undefined)
  return { ok: true, href: agentId ? agentHref(agentId) : '/agents' }
}
