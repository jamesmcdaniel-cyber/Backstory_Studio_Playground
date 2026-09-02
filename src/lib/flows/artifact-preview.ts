/**
 * What a delivery step actually produced, recovered for preview.
 *
 * A send step's OUTPUT is the provider's receipt — `{id, threadId}` — while
 * the thing the user cares about, the email or message itself, is the step's
 * INPUT. The run panel showed that input as raw JSON, so seeing "what did my
 * flow send" meant opening Gmail or Slack. This module recognises the
 * artifact so the panel can render the deliverable the way its recipient
 * sees it.
 *
 * Detection prefers the tool name (exact), falling back to input shape so
 * agent-plane sends and future providers with the same argument conventions
 * preview too. Pure — no DB, no network — and deliberately conservative: a
 * value that only vaguely resembles an email is not an artifact.
 */

export type FlowArtifact =
  | { kind: 'email'; to: string; cc?: string; bcc?: string; subject: string; body: string }
  | { kind: 'message'; channel: string; text: string }
  | { kind: 'record'; object: string; fields: Record<string, unknown> }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

function emailFrom(input: Record<string, unknown>): FlowArtifact | null {
  const to = str(input.to)
  const subject = str(input.subject)
  const body = str(input.body)
  if (!to || !subject || !body) return null
  return { kind: 'email', to, cc: str(input.cc), bcc: str(input.bcc), subject, body }
}

function messageFrom(input: Record<string, unknown>): FlowArtifact | null {
  const channel = str(input.channel)
  const text = str(input.text)
  if (!channel || !text) return null
  return { kind: 'message', channel, text }
}

function recordFrom(input: Record<string, unknown>): FlowArtifact | null {
  const object = str(input.sobject) ?? str(input.object)
  const fields = input.fields
  if (!object || !fields || typeof fields !== 'object' || Array.isArray(fields)) return null
  return { kind: 'record', object, fields: fields as Record<string, unknown> }
}

export function detectArtifact(toolName: string | null | undefined, input: unknown): FlowArtifact | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>

  // Exact tool names first: the name settles what an ambiguous shape is.
  if (toolName) {
    if (/(^|_)send_email$/.test(toolName) || toolName === 'email_send') return emailFrom(record)
    if (/(^|_)post_message$/.test(toolName) || /(^|_)send_message$/.test(toolName)) return messageFrom(record)
    if (/(^|_)create_record$/.test(toolName)) return recordFrom(record)
  }

  // Shape fallback, most specific first.
  return emailFrom(record) ?? messageFrom(record) ?? recordFrom(record)
}
