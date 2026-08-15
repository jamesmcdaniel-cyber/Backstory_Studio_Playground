import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto/secrets'
import { recordCredentialUse, recordCredentialUseFailure } from '@/lib/credentials/audit'

/**
 * Per-workspace credentials for the built-in integrations, and the narrow rule
 * for when a platform-wide env credential may stand in.
 *
 * Slack and Email were keyed to a single global env var each. That is not a
 * missing feature, it is a cross-tenant data path: every workspace's agents
 * posted into the SAME Slack workspace with the same bot token, and sent mail
 * from the same address. An agent in one org could read and write another org's
 * channels, and a bad send burned deliverability for every tenant at once.
 *
 * The rule now: a customer workspace uses its own credential or the integration
 * is simply not available to it. The env fallback survives only for `internal`
 * and `partner` orgs — Backstory's and People.ai's own workspaces, where the
 * shared account IS the right account and there is no third party to leak to.
 *
 * This governs agent TOOLS — an org's agents acting outward. It deliberately
 * does not govern the platform's own transactional mail (invitations), which is
 * Backstory emailing on its own behalf and rightly uses the platform key.
 */

export type CredentialSource = 'org' | 'env'
export type ResolvedCredential = { value: string; source: CredentialSource }

/** Org kinds permitted to fall back to a platform-wide env credential. */
const ENV_FALLBACK_ORG_KINDS = new Set(['internal', 'partner'])

export function envFallbackAllowed(orgKind: string | null | undefined): boolean {
  // Unknown/missing kind is treated as `customer` — fail closed, matching the
  // schema default. A workspace we can't classify does not get the shared account.
  return ENV_FALLBACK_ORG_KINDS.has(orgKind ?? 'customer')
}

/**
 * The decision itself, with no IO: the workspace's own credential always wins;
 * the env value is reachable only by an org kind allowed to use it.
 */
export function chooseCredential(
  orgSecret: string | null | undefined,
  envValue: string | null | undefined,
  orgKind: string | null | undefined,
): ResolvedCredential | null {
  if (orgSecret) return { value: orgSecret, source: 'org' }
  if (envValue && envFallbackAllowed(orgKind)) return { value: envValue, source: 'env' }
  return null
}

/**
 * Who is reading the credential, for the audit trail. Optional: several callers
 * are platform-internal with no acting user, and a missing actor is recorded as
 * such rather than blocking the read.
 */
export interface OrgSecretUseContext {
  actorUserId?: string | null
  executionId?: string | null
  consumer?: string
}

/** The org's stored secret for `provider`, decrypted, or null. */
export async function readOrgSecret(
  organizationId: string,
  provider: string,
  field = 'apiKey',
  context?: OrgSecretUseContext,
): Promise<string | null> {
  const secret = await prisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId, provider } },
  })
  if (!secret?.isActive) return null

  const config =
    secret.authConfig && typeof secret.authConfig === 'object' && !Array.isArray(secret.authConfig)
      ? (secret.authConfig as Record<string, unknown>)
      : {}
  const stored = config[field]
  if (typeof stored !== 'string' || !stored) return null

  try {
    const value = decryptSecret(stored)
    await recordCredentialUse({
      organizationId,
      kind: 'integration_secret',
      credentialId: secret.id,
      provider,
      actorUserId: context?.actorUserId ?? null,
      executionId: context?.executionId ?? null,
      consumer: context?.consumer ?? `integration.${provider}`,
    })
    return value
  } catch {
    // Undecryptable payload (e.g. a rotated ENCRYPTION_KEY). Treat as absent so
    // the caller degrades to "not configured" rather than throwing mid-run —
    // but record it, because silently behaving as "not configured" is exactly
    // how a botched key rotation stays invisible for days.
    await recordCredentialUseFailure({
      organizationId,
      kind: 'integration_secret',
      credentialId: secret.id,
      provider,
      actorUserId: context?.actorUserId ?? null,
      executionId: context?.executionId ?? null,
      consumer: context?.consumer ?? `integration.${provider}`,
      reason: 'decrypt_failed',
    })
    return null
  }
}

/**
 * Resolve a built-in integration's credential for one workspace: its own saved
 * secret, else the platform env value if — and only if — this org kind may use it.
 */
export async function resolveOrgCredential(params: {
  organizationId: string
  provider: string
  field?: string
  envValue: string | undefined
  context?: OrgSecretUseContext
}): Promise<ResolvedCredential | null> {
  const orgSecret = await readOrgSecret(params.organizationId, params.provider, params.field, params.context)
  if (orgSecret) return { value: orgSecret, source: 'org' }

  if (!params.envValue) return null

  const organization = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: { kind: true },
  })
  const resolved = chooseCredential(null, params.envValue, organization?.kind)

  // The env fallback is the one genuinely SHARED credential left in the system —
  // internal and partner orgs acting through Backstory's own account. It has no
  // row to point at, so it is audited under a synthetic id: "which workspace
  // used the platform's Slack token, and when" is precisely the question the
  // shared-credential risk raises, and it would otherwise leave no trace at all.
  if (resolved?.source === 'env') {
    await recordCredentialUse({
      organizationId: params.organizationId,
      kind: 'integration_secret',
      credentialId: `env:${params.provider}`,
      provider: params.provider,
      actorUserId: params.context?.actorUserId ?? null,
      executionId: params.context?.executionId ?? null,
      consumer: params.context?.consumer ?? `integration.${params.provider}.platform_fallback`,
    })
  }

  return resolved
}
