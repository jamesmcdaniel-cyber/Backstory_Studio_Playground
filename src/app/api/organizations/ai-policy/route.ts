import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { normalizeAiEgressPolicy } from '@/lib/security/pii-egress'

/**
 * The workspace AI switch.
 *
 * The refusal an agent run or copilot returns when the switch is off tells the
 * reader "an administrator can turn it back on in Settings" — which was untrue:
 * `aiEgressPolicy` was readable by the enforcement code and writable by nobody
 * short of a database console. This is the missing half.
 *
 * Gated on `security.manage`, the same permission as MFA and SSO enforcement,
 * because it is the same class of decision: a workspace-wide policy whose
 * consequence is that things stop working for everyone.
 */

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const organization = await prisma.organization.findUnique({
    where: { id: auth.organizationId },
    select: { aiEgressPolicy: true },
  })
  return { success: true, aiEgressPolicy: normalizeAiEgressPolicy(organization?.aiEgressPolicy) }
}, { permission: 'security.manage', skipMfaGate: true })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ aiEgressPolicy: z.enum(['allowed', 'blocked']) })
    .parse(await request.json())

  const organization = await prisma.organization.update({
    where: { id: auth.organizationId },
    data: { aiEgressPolicy: body.aiEgressPolicy },
    select: { aiEgressPolicy: true },
  })
  // Turning AI off stops every agent and flow in the workspace, and turning it
  // back on resumes sending tenant data to a processor. Both directions are a
  // fact an auditor will ask about, so both are recorded with who did it.
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'ai.egress_policy_changed',
    actorUserId: auth.dbUser.id,
    resourceType: 'organization',
    resourceId: auth.organizationId,
    detail: { aiEgressPolicy: organization.aiEgressPolicy },
  })
  return { success: true, aiEgressPolicy: normalizeAiEgressPolicy(organization.aiEgressPolicy) }
}, { permission: 'security.manage', skipMfaGate: true })
