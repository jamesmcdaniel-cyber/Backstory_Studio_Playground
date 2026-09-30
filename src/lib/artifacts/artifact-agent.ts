import type { AgentTask } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { provisionAgentFromConfig } from '@/lib/templates/instantiate'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * Every artifact has an agent behind it — the one its assistant runs as. An
 * artifact that arrives without one (an uploaded page nobody assigned, a flow's
 * output) gets a background agent made just for it: named after the artifact,
 * on Opus 5.5, with the Repository and code tools. Its integrations are the
 * artifact's Settings tab, like any other.
 */

export const ARTIFACT_AGENT_TEMPLATE_ID = 'builtin:artifact-editor'

const INSTRUCTIONS = (title: string) => `You maintain the artifact "${title}" — a page people read and click through. You work only through the conversation on that artifact.

When someone asks for a change, make exactly that change to the page with your artifact tools — precise edits, everything else untouched — and keep it working: its views, charts, navigation and scripts. When they ask a question, answer from the page and, where it needs facts the page does not hold, from your connected tools, saying where each fact came from. When they ask for a variant, save it as a new artifact. Never invent numbers.`

/** Make a background agent for one artifact. */
export async function createArtifactAgent(organizationId: string, userId: string, artifactTitle: string): Promise<AgentTask> {
  const title = artifactTitle.trim().slice(0, 80) || 'Artifact'
  const { agent } = await provisionAgentFromConfig(
    organizationId,
    userId,
    {
      name: `${title} · editor`,
      description: `Edits and answers questions about the artifact "${title}". Made for it automatically.`,
      instructions: INSTRUCTIONS(title),
      model: 'claude-opus-5-5',
      integrations: ['Repository', 'Code'],
      icon: 'artifact',
    },
    `${title} · editor`,
    ARTIFACT_AGENT_TEMPLATE_ID,
  )
  return agent
}

/** Attach an agent to an artifact: an existing one this person can use, or a new one made for it. */
export async function attachArtifactAgent(params: { organizationId: string; userId: string; artifactId: string; agentId?: string | null; create?: boolean }): Promise<{ id: string; title: string }> {
  const artifact = await prisma.artifact.findFirst({ where: { id: params.artifactId, organizationId: params.organizationId }, select: { title: true } })
  if (!artifact) throw new Error('Artifact not found.')
  let agent: Pick<AgentTask, 'id' | 'description' | 'metadata'> | null = null
  if (params.create) {
    agent = await createArtifactAgent(params.organizationId, params.userId, artifact.title)
  } else if (params.agentId) {
    agent = await prisma.agentTask.findFirst({
      where: { id: params.agentId, organizationId: params.organizationId, status: 'ACTIVE', ...agentVisibilityScope(params.userId) },
      select: { id: true, description: true, metadata: true },
    })
    if (!agent) throw new Error('Pick an active agent you can use.')
  }
  if (!agent) throw new Error('Pick an agent, or create one for this artifact.')
  await prisma.artifact.update({ where: { id: params.artifactId, organizationId: params.organizationId }, data: { agentTaskId: agent.id } })
  const title = ((agent.metadata as { title?: unknown } | null)?.title as string | undefined) || agent.description.split('\n')[0]
  return { id: agent.id, title }
}
