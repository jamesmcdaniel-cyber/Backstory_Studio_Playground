import type { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { resolveHttpCredential, type HttpCredentialUseContext, type ResolvedHttpCredential } from '@/features/flows/http-auth'

export class CredentialResolverError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'CredentialResolverError'
  }
}

export async function bindCredentialResolver(params: {
  organizationId: string
  userId: string
  resolverId: string
  credentialId: string
}) {
  return tenantTransaction(params.organizationId, async (tx) => {
    const [resolver, credential, user] = await Promise.all([
      tx.credentialResolver.findFirst({
        where: { id: params.resolverId, organizationId: params.organizationId, status: 'active' },
      }),
      tx.httpCredential.findFirst({
        where: {
          id: params.credentialId,
          organizationId: params.organizationId,
          userId: params.userId,
          status: { in: ['verified', 'error'] },
        },
      }),
      tx.user.findFirst({
        where: { id: params.userId, organizationId: params.organizationId, isActive: true },
        select: { id: true },
      }),
    ])
    if (!resolver) throw new CredentialResolverError('The credential resolver is unavailable.', 'RESOLVER_UNAVAILABLE')
    if (!user) throw new CredentialResolverError('The user is inactive or outside this workspace.', 'RESOLVER_USER_UNAVAILABLE')
    if (!credential) {
      throw new CredentialResolverError('Choose one of your own active HTTP credentials.', 'RESOLVER_CREDENTIAL_UNAVAILABLE')
    }
    if (credential.authType !== resolver.authType || credential.allowedHost.toLowerCase() !== resolver.allowedHost.toLowerCase()) {
      throw new CredentialResolverError(
        `Choose a ${resolver.authType} credential for ${resolver.allowedHost}.`,
        'RESOLVER_CREDENTIAL_MISMATCH',
      )
    }
    return tx.credentialResolverBinding.upsert({
      where: {
        organizationId_resolverId_userId: {
          organizationId: params.organizationId,
          resolverId: resolver.id,
          userId: params.userId,
        },
      },
      create: {
        organizationId: params.organizationId,
        resolverId: resolver.id,
        userId: params.userId,
        credentialId: credential.id,
      },
      update: { credentialId: credential.id },
    })
  })
}

/** Resolve a shared graph placeholder to the executing person's own credential. */
export async function resolveCredentialResolver(
  resolverId: string,
  organizationId: string,
  userId: string,
  context?: HttpCredentialUseContext,
): Promise<ResolvedHttpCredential> {
  const resolver = await prisma.credentialResolver.findFirst({
    where: { id: resolverId, organizationId, status: 'active' },
  })
  if (!resolver) throw new CredentialResolverError('The selected credential resolver is unavailable.', 'RESOLVER_UNAVAILABLE')

  const binding = await prisma.credentialResolverBinding.findFirst({
    where: { organizationId, resolverId: resolver.id, userId },
    include: { credential: true, user: { select: { isActive: true } } },
  })
  if (!binding) {
    throw new CredentialResolverError(
      `Connect your ${resolver.authType} credential for ${resolver.allowedHost} before running this workflow.`,
      'RESOLVER_BINDING_REQUIRED',
    )
  }
  const credential = binding.credential
  if (
    !binding.user.isActive ||
    credential.organizationId !== organizationId ||
    credential.userId !== userId ||
    credential.authType !== resolver.authType ||
    credential.allowedHost.toLowerCase() !== resolver.allowedHost.toLowerCase() ||
    !['verified', 'error'].includes(credential.status)
  ) {
    throw new CredentialResolverError(
      `Reconnect your ${resolver.authType} credential for ${resolver.allowedHost}.`,
      'RESOLVER_BINDING_INVALID',
    )
  }
  return resolveHttpCredential(credential.id, organizationId, context)
}

export type CredentialResolverSummary = Prisma.CredentialResolverGetPayload<object> & {
  binding: { credentialId: string } | null
}
