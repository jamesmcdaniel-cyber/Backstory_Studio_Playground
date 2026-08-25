import { z } from 'zod'

const timezoneSchema = z.string().trim().min(1).max(100).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}, 'Unknown IANA timezone')

/** Persisted workflow-level execution policy (separate from canvas data). */
export const flowSettingsSchema = z.object({
  timezone: timezoneSchema.default('UTC'),
  executionOrder: z.enum(['v1', 'v2']).default('v2'),
  errorWorkflowId: z.string().trim().min(1).nullable().default(null),
  callerPolicy: z.enum(['any', 'none', 'sameOwner', 'allowlist']).default('any'),
  allowedCallerFlowIds: z.array(z.string().min(1)).max(200).default([]),
  saveSuccessfulRuns: z.boolean().default(true),
  saveFailedRuns: z.boolean().default(true),
  saveManualRuns: z.boolean().default(true),
  saveExecutionProgress: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(1).max(86_400).nullable().default(null),
  concurrencyLimit: z.number().int().min(1).max(100).nullable().default(null),
  binaryDataMode: z.enum(['database', 'filesystem']).default('database'),
  retentionDays: z.number().int().min(1).max(3650).nullable().default(null),
  availableInMcp: z.boolean().default(true),
}).strict()

export type FlowSettings = z.infer<typeof flowSettingsSchema>

export const DEFAULT_FLOW_SETTINGS: FlowSettings = flowSettingsSchema.parse({})

export function parseFlowSettings(value: unknown): FlowSettings {
  const parsed = flowSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_FLOW_SETTINGS
}

export function subflowCallerAllowed(
  settings: FlowSettings,
  caller: { flowId: string; ownerId: string | null },
  target: { ownerId: string | null },
): boolean {
  switch (settings.callerPolicy) {
    case 'none':
      return false
    case 'sameOwner':
      return Boolean(caller.ownerId && caller.ownerId === target.ownerId)
    case 'allowlist':
      return settings.allowedCallerFlowIds.includes(caller.flowId)
    case 'any':
      return true
  }
}
