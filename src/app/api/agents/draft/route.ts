import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { NANGO_PROVIDERS } from '@/lib/nango/provider-tools'
import { DEFAULT_AGENT_MODEL, generateStructured } from '@/lib/llm/model-runner'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { assertAiCallAllowed } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', description: 'Short agent name, e.g. "Weekly Report Agent".' },
    icon: { type: 'string', description: 'A single emoji that represents the agent, e.g. "📄" or "💰".' },
    description: { type: 'string', description: 'One sentence describing what the agent does.' },
    instructions: {
      type: 'string',
      description: 'Detailed operating instructions for the agent, written in second person, covering goal, steps, tools to use, and what the final report should contain.',
    },
    integrations: {
      type: 'array',
      items: { type: 'string', enum: [...NANGO_PROVIDERS] },
      description: 'Only the integrations the task actually requires.',
    },
    schedule: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekly', 'cron'] },
        time: { type: 'string', description: '24h HH:MM start time; empty string when not applicable.' },
        cron: { type: 'string', description: 'Cron expression; empty string unless type is "cron".' },
        timezone: { type: 'string', description: 'IANA timezone, default UTC.' },
        isActive: { type: 'boolean', description: 'True when the user described a recurring cadence.' },
      },
      required: ['type', 'time', 'cron', 'timezone', 'isActive'],
    },
  },
  required: ['title', 'icon', 'description', 'instructions', 'integrations', 'schedule'],
} as const

type Draft = {
  title: string
  icon: string
  description: string
  instructions: string
  integrations: string[]
  schedule: { type: string; time: string; cron: string; timezone: string; isActive: boolean }
}

// Den-style natural-language agent builder: describe the job, get a ready
// agent config. Pass { create: true } to save it immediately.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { description, create } = z.object({
    description: z.string().min(10).max(4000),
    create: z.boolean().default(false),
  }).parse(await request.json())

  // Provider check, per-user rate limit, and monthly ceiling — the same gate
  // every other interactive LLM endpoint uses. This route previously checked
  // only the monthly budget, so its effective ceiling was the wrapper's generic
  // 240 writes/min: 240 model calls a minute from one account. 10/min matches
  // the flow copilot, the other "generate me a whole config" endpoint.
  await assertAiCallAllowed({
    organizationId: auth.organizationId,
    rateKey: `agent-draft:${auth.dbUser.id}`,
    limit: 10,
  })

  const text = await generateStructured({
    schemaName: 'agent_draft',
    schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
    system: [
      'You configure autonomous agents for a team workspace. Turn the user\'s plain-language description into an agent configuration.',
      `Available integrations: ${NANGO_PROVIDERS.join(', ')}. Include only the ones the task needs; an agent with no integrations is fine.`,
      'Write instructions the agent can follow without further clarification: the goal, the steps, which tools to use, and what to include in the final report. If anything is genuinely ambiguous, instruct the agent to ask the user via its ask_user tool at run time.',
      'Set a schedule only when the user describes a recurring cadence; otherwise use type "manual" with isActive false.',
    ].join('\n'),
    user: description,
  })

  if (!text) throw new ApiError('The model returned no draft', 502, 'DRAFT_FAILED')
  // Rough metering (~chars/4) since generateStructured returns no token usage.
  void recordTokenUsage(auth.organizationId, Math.ceil((description.length + text.length) / 4)).catch(() => undefined)
  const draft = JSON.parse(text) as Draft

  const schedule = {
    type: draft.schedule.type,
    timezone: draft.schedule.timezone || 'UTC',
    isActive: draft.schedule.isActive && draft.schedule.type !== 'manual',
    ...(draft.schedule.time ? { time: draft.schedule.time } : {}),
    ...(draft.schedule.cron ? { cron: draft.schedule.cron } : {}),
  }

  // The model sometimes returns a word (e.g. "test") instead of an emoji for
  // `icon`; that then shows as broken text. Accept it only if it looks like an
  // emoji (no ASCII letters/digits, short), else fall back to a default mark.
  const rawIcon = draft.icon?.trim() || ''
  const icon = rawIcon && !/[A-Za-z0-9]/.test(rawIcon) && [...rawIcon].length <= 4 ? rawIcon : '🤖'
  const enrichedDraft = { ...draft, icon, schedule, model: DEFAULT_AGENT_MODEL, priority: 'medium', visibility: 'shared' as const, folder: null }
  if (!create) {
    return { success: true, draft: enrichedDraft }
  }

  const agent = await prisma.agentTask.create({
    data: {
      type: 'agent',
      agentType: 'CUSTOM',
      priority: 'MEDIUM',
      description: draft.description || draft.title,
      objective: draft.instructions,
      context: {},
      schedule,
      status: 'ACTIVE',
      visibility: 'shared',
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      metadata: {
        title: draft.title,
        description: draft.description,
        model: DEFAULT_AGENT_MODEL,
        integrations: draft.integrations,
        icon,
      },
    },
  })
  return { success: true, draft: enrichedDraft, agentId: agent.id }
}, { permission: 'agent.write' })
