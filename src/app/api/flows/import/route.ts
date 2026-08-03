import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { serializeFlow } from '@/lib/flows/serialize'

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = nativeFlowPackageSchema.parse(await request.json())
  const flow = await prisma.flow.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      name: input.flow.name,
      description: input.flow.description,
      folder: input.flow.folder,
      visibility: input.flow.visibility,
      status: 'DRAFT',
      graph: JSON.parse(JSON.stringify(input.flow.graph)),
      trigger: JSON.parse(JSON.stringify(triggerFromGraph(input.flow.graph))),
    },
  })
  return { success: true, flow: serializeFlow(flow) }
}, { permission: 'flow.write' })
