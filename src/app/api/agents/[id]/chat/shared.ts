import type { NextRequest } from 'next/server'
import type { AgentTask } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * Shared helpers for the agent-scoped assistant chat routes (`/chat` and
 * `/chat/sessions`). Kept out of `route.ts` so both handlers use one agent-id
 * extractor and one access check — and so the proposal shaping below is
 * testable without importing a route module.
 */

/** Synthetic session id for pre-sessions flat threads (sessionId IS NULL). */
export const LEGACY_SESSION_ID = 'legacy'

/** The agent id is the path segment right after `/agents/`. */
export function agentIdFromRequest(request: NextRequest): string {
  const segments = request.nextUrl.pathname.split('/')
  const index = segments.indexOf('agents')
  const id = index >= 0 ? segments[index + 1] : undefined
  if (!id) throw new ApiError('Agent id is required')
  return id
}

/** Load the agent, enforcing tenant + per-rep visibility. Throws 404 otherwise. */
export async function requireAgent(id: string, auth: AuthContext): Promise<AgentTask> {
  const agent = await prisma.agentTask.findFirst({
    where: {
      id,
      organizationId: auth.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(auth.dbUser.id),
    },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent
}

/** A conversation title derived from the first user message. */
export function deriveTitle(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ')
  if (!text) return 'New chat'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export const proposalSchema = z
  .object({
    summary: z.string().default(''),
    target: z.enum(['update', 'new']).nullish(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    instructions: z.string().nullish(),
    model: z.string().nullish(),
    integrations: z.array(z.string()).nullish(),
    skills: z.array(z.string()).nullish(),
    schedule: z
      .object({
        type: z.enum(['manual', 'hourly', 'daily', 'weekly', 'cron']),
        time: z.string().default(''),
        cron: z.string().default(''),
        timezone: z.string().default('UTC'),
        isActive: z.boolean().default(false),
      })
      .nullish(),
  })
  .nullish()

export const runIntentSchema = z
  .object({
    task: z.string().default(''),
  })
  .nullish()

/** A run request as the chat route executes it: one complete instruction. */
export type NormalizedRunIntent = { task: string }

/** Drop empty/whitespace tasks; returns null when there is nothing to run. */
export function normalizeRunIntent(raw: z.infer<typeof runIntentSchema>): NormalizedRunIntent | null {
  const task = raw?.task?.trim()
  return task ? { task } : null
}

/** A proposal as the client receives it: a summary, a destination, the changes. */
export type NormalizedProposal = {
  summary: string
  /** `new` stands up a separate agent; `update` edits the agent in view. */
  target: 'update' | 'new'
  title?: string
  description?: string
  instructions?: string
  model?: string
  integrations?: string[]
  skills?: string[]
  schedule?: { type: string; time?: string; cron?: string; timezone: string; isActive: boolean }
}

/**
 * Drop null/empty fields; returns null when nothing actionable remains.
 *
 * Also settles which agent an applied proposal lands on. Everything defaults to
 * `update` — turning the agent the user is looking at into something else is
 * the destructive direction, so the model has to both ask for `new` and supply
 * instructions a separate agent could actually run on.
 */
export function normalizeProposal(raw: z.infer<typeof proposalSchema>): NormalizedProposal | null {
  if (!raw) return null
  const changes: Partial<Omit<NormalizedProposal, 'summary' | 'target'>> = {}
  if (raw.title?.trim()) changes.title = raw.title.trim()
  if (raw.description?.trim()) changes.description = raw.description.trim()
  if (raw.instructions?.trim()) changes.instructions = raw.instructions.trim()
  if (raw.model?.trim()) changes.model = raw.model.trim()
  if (raw.integrations) changes.integrations = raw.integrations
  if (raw.skills) changes.skills = raw.skills
  if (raw.schedule) {
    changes.schedule = {
      type: raw.schedule.type,
      timezone: raw.schedule.timezone || 'UTC',
      isActive: raw.schedule.type === 'manual' ? false : raw.schedule.isActive,
      ...(raw.schedule.time ? { time: raw.schedule.time } : {}),
      ...(raw.schedule.cron ? { cron: raw.schedule.cron } : {}),
    }
  }
  if (!Object.keys(changes).length) return null
  return {
    ...changes,
    summary: raw.summary?.trim() || 'Configuration update',
    target: raw.target === 'new' && changes.instructions ? 'new' : 'update',
  }
}
