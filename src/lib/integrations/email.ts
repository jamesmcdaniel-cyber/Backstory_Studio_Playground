/**
 * Email integration via Resend REST API
 *
 * Exposes one agent tool — send — that lets agents send emails during a run.
 *
 * TWO different things live in this file, and the distinction is the point:
 *
 *  - `sendEmail` is PLATFORM transactional mail (invitations). Backstory
 *    emailing on its own behalf, from its own address — the env key is correct
 *    here and stays.
 *  - `EmailToolClient` is an AGENT tool: a workspace's agent sending arbitrary
 *    mail outward. That must never run on a shared platform identity. It used
 *    to, which meant every org's agents sent from one address, sharing sender
 *    reputation and receiving each other's bounces and replies.
 *
 * Agent-tool key resolution (per organization, see org-credential.ts):
 *  1. The workspace's own Resend key from integration_secrets (provider 'email').
 *  2. RESEND_API_KEY — reachable ONLY by internal/partner workspaces.
 *
 * Optional: EMAIL_FROM (defaults to "Backstory <onboarding@resend.dev>").
 * All env vars are read at call time (never at module load) so that the
 * Next.js build succeeds even when they are not set.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { resolveOrgCredential, type ResolvedCredential } from './org-credential'

const RESEND_API_URL = 'https://api.resend.com/emails'

export const EMAIL_PROVIDER = 'email'

// ---------------------------------------------------------------------------
// Per-org key resolution (agent tool)
// ---------------------------------------------------------------------------

export async function getEmailCredential(organizationId: string): Promise<ResolvedCredential | null> {
  return resolveOrgCredential({
    organizationId,
    provider: EMAIL_PROVIDER,
    envValue: process.env.RESEND_API_KEY,
  })
}

export async function emailConfigured(organizationId: string): Promise<boolean> {
  return Boolean(await getEmailCredential(organizationId))
}

/** True when the PLATFORM can send its own transactional mail (invitations). */
export function platformEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

/**
 * Send a transactional email via Resend, as the PLATFORM (invitations). Returns
 * false (without throwing) when no RESEND_API_KEY is configured, so callers can
 * degrade gracefully (e.g. show the invite link to copy manually). Throws only
 * on an actual API failure.
 *
 * Not org-scoped on purpose — see the note at the top of this file.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string
  subject: string
  html?: string
  text?: string
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return false
  const from = process.env.EMAIL_FROM || 'Backstory <onboarding@resend.dev>'
  const payload: Record<string, unknown> = { from, to: [to], subject }
  if (html) {
    payload.html = html
    payload.text = text ?? html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
  } else {
    payload.text = text ?? ''
  }
  const response = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Email API error ${response.status}`)
  return true
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function emailTools(): ToolDefinition[] {
  return [
    {
      name: 'send',
      description: 'Send an email to one recipient.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient email address' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'email body — HTML (preferred) or plain text' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// EmailToolClient
// ---------------------------------------------------------------------------

export class EmailToolClient {
  // The resolved per-org key is injected at construction (see
  // getEmailCredential), like GranolaToolClient — so an agent can only ever send
  // as the workspace it belongs to.
  constructor(private readonly apiKey: string) {}

  // Satisfies the McpToolClient interface in execute-agent.ts:
  //   executeTool(serverUrl, name, args): Promise<any>
  // Returns the parsed JSON object directly — the same shape as
  // GranolaToolClient.executeTool, so the run loop's JSON.stringify(result)
  // wrapping is identical for all integrations.
  async executeTool(
    _serverUrl: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const apiKey = this.apiKey
    if (!apiKey) throw new Error('Resend API key is not configured')

    if (name === 'send') {
      const from = process.env.EMAIL_FROM || 'Backstory <onboarding@resend.dev>'
      const body = typeof args.body === 'string' ? args.body : String(args.body ?? '')

      // Agents are instructed to compose HTML email bodies; send those as html
      // (with a tag-stripped plain-text fallback for non-HTML clients). A plain
      // body still sends as text, so this stays correct either way.
      const looksHtml = /<[a-z][\s\S]*>/i.test(body)
      const payload: Record<string, unknown> = { from, to: [args.to], subject: args.subject }
      if (looksHtml) {
        payload.html = body
        payload.text = body.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
      } else {
        payload.text = body
      }

      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        throw new Error(`Email API error ${response.status}`)
      }

      return response.json() as Promise<unknown>
    }

    throw new Error(`Unknown Email tool: ${name}`)
  }
}
