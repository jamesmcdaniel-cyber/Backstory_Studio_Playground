import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { normalizeCommand } from '@/lib/slack/command'

export const runtime = 'nodejs'

/**
 * Which teammate a Slack slash command reaches.
 *
 * Same shape and same ruling as channel-bindings: the agent is tenant-checked
 * on write, because the foreign key alone would accept ANY org's agent id and
 * file a binding onto a stranger's roster.
 *
 * The command is normalized on the way in (leading slash dropped, lowercased)
 * so `/DealCheck`, `dealcheck` and `/dealcheck` all bind the same thing — the
 * receiver normalizes identically, and a binding that only matched one spelling
 * would fail in a way nobody could see from this page.
 */
const command = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform(normalizeCommand)
  // Slack's own rule for command names, applied here so an unusable binding is
  // refused at the point it is created rather than at the point it is invoked.
  .refine((value) => /^[a-z0-9_-]+$/.test(value), 'A command may only contain letters, numbers, hyphens and underscores.')

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const bindings = await prisma.slackCommandBinding.findMany({
    where: { organizationId: auth.organizationId },
    select: { command: true, agentTaskId: true, updatedAt: true },
    orderBy: { command: 'asc' },
    take: 200,
  })
  return { success: true, bindings }
}, { permission: 'agent.read' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ command, agentTaskId: z.string().min(1) }).parse(await request.json())

  const agent = await prisma.agentTask.findFirst({
    where: { id: input.agentTaskId, organizationId: auth.organizationId, status: { not: 'DELETED' } },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const binding = await prisma.slackCommandBinding.upsert({
    where: { organizationId_command: { organizationId: auth.organizationId, command: input.command } },
    update: { agentTaskId: input.agentTaskId },
    create: { organizationId: auth.organizationId, command: input.command, agentTaskId: input.agentTaskId },
    select: { command: true, agentTaskId: true },
  })
  return { success: true, binding }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ command }).parse(await request.json())
  await prisma.slackCommandBinding.deleteMany({
    where: { organizationId: auth.organizationId, command: input.command },
  })
  return { success: true }
}, { permission: 'agent.write' })
