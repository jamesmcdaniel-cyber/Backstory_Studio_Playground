import { z } from 'zod'

/**
 * The artifact assistant's settings, as stored on Artifact.assistantConfig: a
 * leaf module (no data-layer imports) so the artifact service can read them
 * without pulling in the tool catalog. Loading and saving live in
 * ./assistant-config.
 */

export const ASSISTANT_INSTRUCTIONS_MAX = 4_000
export const ASSISTANT_TOOLS_MAX = 30

export type AssistantConfig = { instructions: string; toolConnectionIds: string[] }

export const assistantConfigSchema = z.object({
  instructions: z.string().max(ASSISTANT_INSTRUCTIONS_MAX).default(''),
  toolConnectionIds: z.array(z.string().regex(/^(?:native|nango):[A-Za-z0-9_.-]{1,80}$/)).max(ASSISTANT_TOOLS_MAX).default([]),
})

export function readAssistantConfig(value: unknown): AssistantConfig {
  const parsed = assistantConfigSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : { instructions: '', toolConnectionIds: [] }
}
