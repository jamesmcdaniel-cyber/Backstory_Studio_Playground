import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/crypto/secrets'

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

/** The org's stored secret for `provider`, decrypted, or null. */
export async function readOrgSecret(
  organizationId: string,
  provider: string,
  field = 'apiKey',
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
    return decryptSecret(stored)
  } catch {
    // Undecryptable payload (e.g. a rotated ENCRYPTION_KEY). Treat as absent so
    // the caller degrades to "not configured" rather than throwing mid-run.
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
}): Promise<ResolvedCredential | null> {
  const orgSecret = await readOrgSecret(params.organizationId, params.provider, params.field)
  if (orgSecret) return { value: orgSecret, source: 'org' }

  if (!params.envValue) return null

  const organization = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: { kind: true },
  })
  return chooseCredential(null, params.envValue, organization?.kind)
}
