import { nativeFlowPackage, nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { serializeFlow } from '@/lib/flows/serialize'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { recordAudit } from '@/lib/audit'

function idOf(request: Request) {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

// An API key acts as the person who minted it: it reaches their own private
// flows and the workspace's shared ones, never another member's private work.
// Applied to writes as well as reads — being able to delete what you cannot
// read would be a stranger boundary than either rule alone.
export async function GET(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:read')
  if (auth instanceof Response) return auth
  const flow = await prisma.flow.findFirst({
    where: { id: idOf(request), organizationId: auth.organizationId, ...agentVisibilityScope(auth.userId) },
  })
  if (!flow) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  return publicApiJson({ data: serializeFlow(flow), package: nativeFlowPackage(flow) })
}

export async function PUT(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:write')
  if (auth instanceof Response) return auth
  const parsed = nativeFlowPackageSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return publicApiJson({ error: { code: 'INVALID_PACKAGE', message: 'Expected a backstory.flow.v1 package.', issues: parsed.error.issues } }, 400)
  const id = idOf(request)
  const updated = await prisma.flow.updateMany({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.userId) },
    data: {
      name: parsed.data.flow.name,
      description: parsed.data.flow.description,
      folder: parsed.data.flow.folder,
      visibility: parsed.data.flow.visibility,
      graph: JSON.parse(JSON.stringify(parsed.data.flow.graph)),
      trigger: JSON.parse(JSON.stringify(triggerFromGraph(parsed.data.flow.graph))),
    },
  })
  if (!updated.count) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  const flow = await prisma.flow.findFirstOrThrow({ where: { id, organizationId: auth.organizationId } })
  await recordAudit({ organizationId: auth.organizationId, actorUserId: auth.userId, action: 'flow.api_updated', resourceType: 'flow', resourceId: id, detail: { format: 'backstory.flow.v1' } }).catch(() => undefined)
  return publicApiJson({ data: serializeFlow(flow) })
}

export async function DELETE(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:write')
  if (auth instanceof Response) return auth
  const result = await prisma.flow.deleteMany({
    where: { id: idOf(request), organizationId: auth.organizationId, ...agentVisibilityScope(auth.userId) },
  })
  if (!result.count) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  return new Response(null, { status: 204 })
}
