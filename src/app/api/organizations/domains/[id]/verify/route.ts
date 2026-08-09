import { resolveTxt } from 'node:dns/promises'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Domain id is required.')
  const domain = await prisma.organizationDomain.findFirst({ where: { id, organizationId: auth.organizationId } })
  if (!domain) throw new ApiError('Domain not found.', 404, 'NOT_FOUND')

  let records: string[][] = []
  try { records = await resolveTxt(`_backstory-verification.${domain.domain}`) } catch { /* not propagated */ }
  const expected = `backstory-verification=${domain.verificationToken}`
  if (!records.some((parts) => parts.join('') === expected)) {
    throw new ApiError('Verification TXT record was not found yet.', 409, 'DNS_NOT_VERIFIED')
  }
  const verified = await prisma.organizationDomain.update({
    where: { id, organizationId: auth.organizationId },
    data: { status: 'verified', verifiedAt: new Date() },
    select: { id: true, domain: true, status: true, verifiedAt: true },
  })
  return { success: true, domain: verified }
}, { permission: 'security.manage', skipMfaGate: true })
