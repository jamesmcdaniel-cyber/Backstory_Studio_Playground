import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { flowGraphSchema } from '@/lib/flows/graph'
import { looksLikeN8nWorkflow, n8nToFlow, resolveN8nImportUrl, unwrapN8nPayload } from '@/lib/flows/import/from-n8n'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { serializeFlow } from '@/lib/flows/serialize'

const URL_IMPORT_MAX_BYTES = 5_000_000

/** Fetch a user-supplied import URL server-side (browser CORS can't) — SSRF-guarded, size- and time-capped. */
async function fetchImportUrl(raw: string): Promise<unknown> {
  const target = resolveN8nImportUrl(raw.trim())
  try {
    await assertPublicUrl(target)
  } catch (error) {
    throw new ApiError(error instanceof SsrfError ? error.message : 'That URL cannot be fetched.', 400, 'BAD_IMPORT_URL')
  }
  let response: Response
  try {
    response = await fetch(target, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApiError('Could not reach that URL.', 400, 'BAD_IMPORT_URL')
  }
  if (!response.ok) throw new ApiError(`That URL answered ${response.status} — it must serve the workflow JSON.`, 400, 'BAD_IMPORT_URL')
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > URL_IMPORT_MAX_BYTES) throw new ApiError('That file is too large to import (5 MB max).', 413, 'IMPORT_TOO_LARGE')
  const text = await response.text()
  if (text.length > URL_IMPORT_MAX_BYTES) throw new ApiError('That file is too large to import (5 MB max).', 413, 'IMPORT_TOO_LARGE')
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('That URL did not return JSON. For n8n.io, paste the template page URL; otherwise link the raw workflow JSON.', 400, 'BAD_IMPORT_URL')
  }
}

// POST /api/flows/import — accepts, in one endpoint:
//   { url }                    → fetch (SSRF-guarded) then treat as below
//   an n8n workflow export     → converted via n8nToFlow (warnings returned)
//   a native Backstory package → imported as-is
export const POST = withAuthenticatedApi(async (request, auth) => {
  let payload: unknown = await request.json()
  const asRecord = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  if (asRecord && typeof asRecord.url === 'string' && !Array.isArray(asRecord.nodes) && !asRecord.flow) {
    payload = await fetchImportUrl(asRecord.url)
  }
  payload = unwrapN8nPayload(payload)

  if (looksLikeN8nWorkflow(payload)) {
    const converted = n8nToFlow(payload)
    const graph = flowGraphSchema.parse(converted.graph)
    const flow = await prisma.flow.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        name: converted.name,
        status: 'DRAFT',
        graph: JSON.parse(JSON.stringify(graph)),
        trigger: JSON.parse(JSON.stringify(triggerFromGraph(graph))),
      },
    })
    return { success: true, flow: serializeFlow(flow), warnings: converted.warnings, source: 'n8n' }
  }

  const parsed = nativeFlowPackageSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ApiError('That JSON is neither a Backstory flow package nor an n8n workflow export.', 400, 'UNRECOGNIZED_IMPORT')
  }
  const input = parsed.data
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
  return { success: true, flow: serializeFlow(flow), source: 'native' }
}, { permission: 'flow.write' })
