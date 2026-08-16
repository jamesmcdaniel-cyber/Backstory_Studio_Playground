/**
 * Deterministic enforcement at the tool-call boundary.
 *
 * The fencing rule and the guardrails are prompt-level instructions: they
 * change the odds a model complies with injected content, not what happens if
 * it does. A sufficiently good jailbreak talks the model into WANTING to make
 * the call. This layer is what holds at that point, because it runs in code,
 * after the model has decided and before anything leaves — the model cannot be
 * argued with here because there is no model here.
 *
 * ── What is enforced deterministically, and why only this ──────────────────
 *
 * BLOCKED — a tool call whose arguments carry a credential-shaped value. This
 * is guardrail boundary #1 (credential exfiltration) made mechanical: vendor
 * key prefixes (sk-ant-…, xoxb-…, AKIA…), bearer/JWT shapes, and our own
 * v1:/v2:/b64: ciphertext envelopes are never legitimate CONTENT for a
 * message, document, record or request the model composes. Credentials enter
 * requests through the credential store's own header injection, which does not
 * pass through model-authored arguments — so a match here is either a leak in
 * progress or content quoting a live secret, and both deserve a hard stop.
 *
 * FLAGGED, not blocked — injection-shaped instructions in tool RETURNS. "What
 * is an instruction" is a judgment call, and judgment calls do not belong in a
 * deterministic layer: an email that says "ignore previous instructions" might
 * be an article ABOUT prompt injection. Blocking on it would break legitimate
 * reads; recording it makes probing visible, which is the part detection can
 * honestly deliver.
 *
 * The asymmetry is the design: block only what has no legitimate form,
 * observe everything else.
 */

import { recordAudit } from '@/lib/audit'

/**
 * Credential shapes with effectively no false-positive surface. Anchored on
 * the same signatures the log redactor uses — a string starting sk-ant- or
 * xoxb- IS a credential, and our own ciphertext envelope prefix cannot occur
 * in prose by accident.
 *
 * Deliberately NARROWER than the redactor: the redactor may over-match
 * because redacting too much text costs little, but BLOCKING a tool call on a
 * false positive breaks a run — so only unambiguous shapes qualify. Generic
 * high-entropy strings, UUIDs and hashes are exactly what CRM data is full of.
 */
const BLOCKING_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { reason: 'openai_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { reason: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}/ },
  { reason: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}/ },
  { reason: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/ },
  { reason: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{16,}/ },
  { reason: 'google_oauth_token', pattern: /\bya29\.[A-Za-z0-9_-]{16,}/ },
  { reason: 'stripe_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { reason: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Our own encrypted-secret envelopes: nothing model-authored has any
  // business quoting a stored ciphertext.
  { reason: 'platform_ciphertext', pattern: /\b(?:v1|v2):[A-Za-z0-9+/=:]{16,}|\bb64:[A-Za-z0-9+/=]{12,}/ },
]

export interface ToolCallVerdict {
  allowed: boolean
  /** Which shapes matched — reasons only, never the matched values. */
  reasons: string[]
}

/**
 * Inspect model-authored tool arguments for credential-shaped values.
 *
 * Pure and synchronous — it sits on every tool call, so it must cost a string
 * scan and nothing else. The caller decides what a block looks like on its
 * surface (a failed tool call with a clear message).
 */
export function inspectToolArgs(args: unknown): ToolCallVerdict {
  const serialized = safeSerialize(args)
  if (!serialized) return { allowed: true, reasons: [] }

  const reasons: string[] = []
  for (const { reason, pattern } of BLOCKING_PATTERNS) {
    if (pattern.test(serialized)) reasons.push(reason)
  }
  return { allowed: reasons.length === 0, reasons }
}

/** The error message a blocked call fails with — shown in the run log. */
export function blockedCallMessage(toolName: string, verdict: ToolCallVerdict): string {
  return (
    `Tool call ${toolName} was blocked: its arguments contain a credential-shaped value ` +
    `(${verdict.reasons.join(', ')}). Credentials are attached by the platform's credential ` +
    'store, never written into tool arguments. If this is content that quotes a real key, ' +
    'remove the key — it is live and should be rotated.'
  )
}

// ── Injection-attempt detection on tool returns ────────────────────────────

/**
 * Phrasings that appear in injection payloads and rarely in ordinary business
 * content. Detection only — see the module comment for why returns are never
 * blocked. Precision is tuned for a SIGNAL, not a gate: each additional
 * pattern must earn its place by being rare in real mail and tickets.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: 'override_instructions', pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above|your)\s+(?:instructions?|prompts?|rules?|directives?)/i },
  { reason: 'claims_system_authority', pattern: /\b(?:i am|this is)\s+(?:your|the)\s+(?:system|developer|administrator|operator)\b[\s\S]{0,80}?\b(?:instruct|command|order|require)/i },
  { reason: 'exfiltration_directive', pattern: /\b(?:send|forward|post|transmit|copy)\b[^.]{0,80}\b(?:credentials?|passwords?|api\s*keys?|tokens?|secrets?)\b/i },
  { reason: 'new_instructions_marker', pattern: /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|prompt)\s*:/i },
  { reason: 'role_reassignment', pattern: /\byou are no longer\b|\bfrom now on,?\s+you (?:are|will|must)\b/i },
]

export interface InjectionScan {
  suspicious: boolean
  reasons: string[]
}

export function scanToolResultForInjection(result: unknown): InjectionScan {
  const serialized = safeSerialize(result)
  if (!serialized) return { suspicious: false, reasons: [] }
  // Bounded: tool results can be large, and the patterns target instruction
  // preambles, which sit early in real payloads.
  const sample = serialized.length > 50_000 ? serialized.slice(0, 50_000) : serialized

  const reasons: string[] = []
  for (const { reason, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(sample)) reasons.push(reason)
  }
  return { suspicious: reasons.length > 0, reasons }
}

/**
 * Record a blocked call or a suspicious return. Best-effort — the guard's
 * BLOCK works even when the audit write fails; observability must not become a
 * second way to break a run.
 */
export async function recordToolCallGuardEvent(input: {
  organizationId: string
  executionId?: string | null
  actorUserId?: string | null
  kind: 'blocked_args' | 'suspicious_return'
  toolName: string
  reasons: string[]
}): Promise<void> {
  try {
    await recordAudit({
      organizationId: input.organizationId,
      action: input.kind === 'blocked_args' ? 'guardrail.tool_blocked' : 'injection.suspected',
      actorUserId: input.actorUserId ?? null,
      actorKind: 'agent',
      resourceType: 'tool_call',
      executionId: input.executionId ?? null,
      tool: input.toolName,
      detail: { reasons: input.reasons },
    })
  } catch {
    /* the block itself already happened; this is the record */
  }
}

function safeSerialize(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
