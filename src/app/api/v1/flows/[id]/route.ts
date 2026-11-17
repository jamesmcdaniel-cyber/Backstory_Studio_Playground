import { nativeFlowPackage, nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { serializeFlow } from '@/lib/flows/serialize'
import { draftGraphTriggerColumns } from '@/lib/flows/trigger-columns'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { recordAudit } from '@/lib/audit'
import { readRequestJsonLimited, RequestBodyError } from '@/lib/server/request-body'

const PUBLIC_FLOW_PACKAGE_MAX_BODY_BYTES = 4_000_000

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
  let raw: unknown
  try {
    raw = await readRequestJsonLimited(request, PUBLIC_FLOW_PACKAGE_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError) return publicApiJson({ error: { code: error.code, message: error.message } }, error.status)
    throw error
  }
  const parsed = nativeFlowPackageSchema.safeParse(raw)
  if (!parsed.success) return publicApiJson({ error: { code: 'INVALID_PACKAGE', message: 'Expected a backstory.flow.v1 package.', issues: parsed.error.issues } }, 400)
  const id = idOf(request)
  const scope = { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.userId) }
  const existing = await prisma.flow.findFirst({ where: scope, select: { trigger: true, publishedGraph: true, updatedAt: true } })
  if (!existing) return publicApiJson({ error: { code: 'NOT_FOUND', message: 'Flow not found.' } }, 404)
  // Same trigger rules as the builder's save: a package graph never carries
  // the webhook secret hash (the export strips it), so it is kept from the
  // row; an unchanged schedule keeps its anchor; and a published flow's live
  // trigger is left for publish to change.
  const triggerColumns = draftGraphTriggerColumns(parsed.data.flow.graph, existing) ?? {}
  const updated = await prisma.flow.updateMany({
    // Conditional on the row we derived from, so a concurrent save can't have
    // its trigger (or secret) overwritten with one computed from older state.
    where: { ...scope, updatedAt: existing.updatedAt },
    data: {
      name: parsed.data.flow.name,
      description: parsed.data.flow.description,
      folder: parsed.data.flow.folder,
      visibility: parsed.data.flow.visibility,
      graph: JSON.parse(JSON.stringify(parsed.data.flow.graph)),
      ...triggerColumns,
    },
  })
  if (!updated.count) return publicApiJson({ error: { code: 'CONFLICT', message: 'The flow changed while it was being updated — retry.' } }, 409)
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
