/**
 * Credential lifecycle audit.
 *
 * The 2026-08-15 governance audit found the audit log could say who REMOVED a
 * credential — `credential.revoked`, `member.deprovisioned` — and nothing else.
 * All five connect/callback routes recorded nothing, and no read path recorded
 * anything, so "who authorized this connection" and "what used it" were both
 * unanswerable. That is the specific question a security review asks, and the
 * one the revocation spine could not answer on its own.
 *
 * Grant, rotate and revoke are low-volume and always recorded.
 *
 * USE is different: a single flow run can touch the same credential on every
 * step of every item, so recording each read would add far more rows than the
 * rest of the audit log combined and bury the events that matter. Uses are
 * therefore deduplicated to one row per credential per actor per execution,
 * which is the grain an investigator actually asks in ("did this run touch the
 * Salesforce credential?"), not one per HTTP call.
 */

import { recordAudit } from '@/lib/audit'

/** Which store the credential lives in. Mirrors the Prisma model names. */
export type CredentialKind =
  | 'nango_connection'
  | 'mcp_connection'
  | 'people_ai_connection'
  | 'http_credential'
  | 'integration_secret'
  | 'api_key'
  /** The shared secret an audit-stream destination signs its deliveries with. */
  | 'audit_stream'
  | 'external_secret_provider'

export const CREDENTIAL_GRANTED = 'credential.granted'
export const CREDENTIAL_ROTATED = 'credential.rotated'
export const CREDENTIAL_USED = 'credential.used'
export const CREDENTIAL_USE_FAILED = 'credential.use_failed'

interface CredentialRef {
  organizationId: string
  kind: CredentialKind
  credentialId: string
  provider?: string | null
  /** The person the credential belongs to — null for org-shared credentials. */
  ownerUserId?: string | null
}

interface GrantInput extends CredentialRef {
  /** Who authorized it. Null only for provider-initiated webhook callbacks. */
  actorUserId?: string | null
  /** Scopes the provider actually granted, when it tells us. */
  scopes?: string[] | string | null
  /** How the credential was established, e.g. 'oauth_authcode', 'api_key_entry'. */
  method?: string
}

/**
 * A credential was newly authorized, or re-authorized with fresh material.
 *
 * `scopes` is recorded because an over-scoped grant is invisible otherwise —
 * the connection looks identical whether it asked for read or read/write.
 */
export async function recordCredentialGrant(input: GrantInput): Promise<void> {
  await recordAudit({
    organizationId: input.organizationId,
    action: CREDENTIAL_GRANTED,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorUserId ? 'user' : 'system',
    resourceType: input.kind,
    resourceId: input.credentialId,
    detail: {
      provider: input.provider ?? null,
      ownerUserId: input.ownerUserId ?? null,
      scopes: normalizeScopes(input.scopes),
      method: input.method ?? null,
    },
  })
}

/** Existing credential material was replaced — a rotation, not a new grant. */
export async function recordCredentialRotation(
  input: GrantInput & { reason?: string },
): Promise<void> {
  await recordAudit({
    organizationId: input.organizationId,
    action: CREDENTIAL_ROTATED,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorUserId ? 'user' : 'system',
    resourceType: input.kind,
    resourceId: input.credentialId,
    detail: {
      provider: input.provider ?? null,
      ownerUserId: input.ownerUserId ?? null,
      scopes: normalizeScopes(input.scopes),
      reason: input.reason ?? null,
    },
  })
}

// ── Use events ─────────────────────────────────────────────────────────────

interface UseInput extends CredentialRef {
  /** Who the work is running as. */
  actorUserId?: string | null
  actorKind?: 'user' | 'agent' | 'system'
  /** The flow run or agent execution this read belongs to, when there is one. */
  executionId?: string | null
  /** What consumed it, e.g. 'flow.http_step', 'mcp.tool_call'. */
  consumer?: string
}

/**
 * The dedup window for uses that have no execution to key on (a UI-initiated
 * verify, a scheduled refresh). Bounded so an ad-hoc path still produces a
 * periodic trail rather than either one row per call or nothing at all.
 */
const ADHOC_DEDUP_MS = 15 * 60 * 1000

/**
 * Best-effort, per-process dedup.
 *
 * On serverless each instance keeps its own map, so the same credential can
 * produce one row per warm instance. That is the right trade: the alternative
 * is a read-and-write against the audit table on every credential read, which
 * puts a database round trip in the hot path of every flow step to save rows we
 * are happy to have duplicated. Over-recording is a survivable failure here;
 * under-recording is the one this module exists to prevent.
 */
const recentUses = new Map<string, number>()
const MAX_TRACKED_USES = 5_000

function shouldRecordUse(key: string, now: number, windowMs: number): boolean {
  const last = recentUses.get(key)
  if (last !== undefined && now - last < windowMs) return false

  // Cheap bound: once the map is large, drop the oldest half rather than
  // growing without limit in a long-lived worker process.
  if (recentUses.size >= MAX_TRACKED_USES) {
    const entries = [...recentUses.entries()].sort((a, b) => a[1] - b[1])
    for (const [staleKey] of entries.slice(0, Math.floor(entries.length / 2))) {
      recentUses.delete(staleKey)
    }
  }

  recentUses.set(key, now)
  return true
}

/** Exposed for tests — the dedup cache is process state, not a pure function. */
export function __resetUseDedupForTests(): void {
  recentUses.clear()
}

export async function recordCredentialUse(input: UseInput): Promise<void> {
  const key = [
    input.organizationId,
    input.kind,
    input.credentialId,
    input.actorUserId ?? 'anon',
    input.executionId ?? 'adhoc',
  ].join(':')

  // A use inside an execution is recorded once for that execution and never
  // again; an ad-hoc use falls back to a time window.
  const windowMs = input.executionId ? Number.POSITIVE_INFINITY : ADHOC_DEDUP_MS
  if (!shouldRecordUse(key, Date.now(), windowMs)) return

  await recordAudit({
    organizationId: input.organizationId,
    action: CREDENTIAL_USED,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorKind ?? 'agent',
    resourceType: input.kind,
    resourceId: input.credentialId,
    executionId: input.executionId ?? null,
    detail: {
      provider: input.provider ?? null,
      ownerUserId: input.ownerUserId ?? null,
      consumer: input.consumer ?? null,
    },
  })
}

/**
 * A credential was present but could not be used — decrypt failure, refresh
 * rejected, provider 401.
 *
 * NOT deduplicated: failures are low-volume and each one is a signal. A token
 * revoked at the provider and a wrong ENCRYPTION_KEY look identical from the
 * outside, and the count over time is what distinguishes them.
 */
export async function recordCredentialUseFailure(
  input: UseInput & { reason: string },
): Promise<void> {
  await recordAudit({
    organizationId: input.organizationId,
    action: CREDENTIAL_USE_FAILED,
    actorUserId: input.actorUserId ?? null,
    actorKind: input.actorKind ?? 'agent',
    resourceType: input.kind,
    resourceId: input.credentialId,
    executionId: input.executionId ?? null,
    detail: {
      provider: input.provider ?? null,
      ownerUserId: input.ownerUserId ?? null,
      consumer: input.consumer ?? null,
      reason: input.reason,
    },
  })
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Scopes arrive as a space-delimited string from OAuth, an array from Nango,
 * or not at all. Normalised to a sorted array so two grants of the same access
 * compare equal in the log regardless of the order the provider listed them.
 */
export function normalizeScopes(scopes: string[] | string | null | undefined): string[] | null {
  if (!scopes) return null
  const list = Array.isArray(scopes) ? scopes : scopes.split(/[\s,]+/)
  const cleaned = [...new Set(list.map((scope) => scope.trim()).filter(Boolean))].sort()
  return cleaned.length ? cleaned : null
}
