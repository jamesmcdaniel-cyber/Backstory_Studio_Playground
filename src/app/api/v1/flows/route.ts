import { emptyGraph } from '@/lib/flows/graph'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { serializeFlow } from '@/lib/flows/serialize'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson } from '@/lib/public-api/auth'

export async function GET(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:read')
  if (auth instanceof Response) return auth
  const flows = await prisma.flow.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return publicApiJson({ data: flows.map((flow) => serializeFlow(flow)) })
}

export async function POST(request: Request) {
  const auth = await authenticatePublicApi(request, 'flows:write')
  if (auth instanceof Response) return auth
  const raw = await request.json().catch(() => null)
  const parsed = nativeFlowPackageSchema.safeParse(raw)
  if (!parsed.success) return publicApiJson({ error: { code: 'INVALID_PACKAGE', message: 'Expected a backstory.flow.v1 package.', issues: parsed.error.issues } }, 400)
  const graph = parsed.data.flow.graph ?? emptyGraph()
  const flow = await prisma.flow.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.userId,
      name: parsed.data.flow.name,
      description: parsed.data.flow.description,
      folder: parsed.data.flow.folder,
      visibility: parsed.data.flow.visibility,
      status: 'DRAFT',
      graph: JSON.parse(JSON.stringify(graph)),
      trigger: JSON.parse(JSON.stringify(triggerFromGraph(graph))),
    },
  })
  return publicApiJson({ data: serializeFlow(flow) }, 201)
}
