/**
 * Request bodies for registering and editing an external agent. Shared by the
 * session routes; client-safe (zod only).
 */

import { z } from 'zod'
import { EXTERNAL_TIMEOUT_MAX_MINUTES, EXTERNAL_TIMEOUT_MIN_MINUTES } from './types'

const httpsUrl = z
  .string()
  .trim()
  .url('Enter the full webhook URL, starting with https://')
  .max(2000)
  .refine((value) => value.startsWith('https://'), 'The webhook must use https://')

export const registerExternalAgentSchema = z.object({
  name: z.string().trim().min(1, 'Give the agent a name').max(60),
  roleLabel: z.string().trim().max(40).nullish(),
  description: z.string().trim().max(2000).nullish(),
  avatarSeed: z.string().trim().max(120).nullish(),
  webhookUrl: httpsUrl,
  capabilities: z.string().trim().max(4000).nullish(),
  replyTimeoutMinutes: z.number().int().min(EXTERNAL_TIMEOUT_MIN_MINUTES).max(EXTERNAL_TIMEOUT_MAX_MINUTES).optional(),
})

export const updateExternalAgentSchema = registerExternalAgentSchema.partial().extend({
  enabled: z.boolean().optional(),
})

export const rotateExternalAgentSchema = z.object({
  credential: z.enum(['signing_secret', 'api_key']),
})

/** What an external agent's reply may carry. */
export const externalReplySchema = z.object({
  replyToken: z.string().max(256).optional(),
  status: z.enum(['completed', 'failed']),
  output: z.string().max(100_000).default(''),
  error: z.string().max(2000).optional(),
  links: z.array(z.object({ title: z.string().max(200).optional(), url: z.string().url().max(2000) })).max(20).optional(),
  artifacts: z.array(z.object({ title: z.string().max(200).optional(), url: z.string().url().max(2000) })).max(20).optional(),
})

export const externalProgressSchema = z.object({
  replyToken: z.string().max(256).optional(),
  message: z.string().trim().min(1).max(500),
})
