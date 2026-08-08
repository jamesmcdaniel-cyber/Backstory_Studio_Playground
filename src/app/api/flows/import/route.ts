import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { looksLikeN8nWorkflow, n8nToFlow, resolveN8nImportUrl, unwrapN8nPayload, type N8nAgentSpec } from '@/lib/flows/import/from-n8n'
import { bindImportedHttpAuth, dropStaleAuthWarnings } from '@/lib/flows/import/bind-imported-auth'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { triggerFromGraph } from '@/lib/flows/trigger'
import { serializeFlow } from '@/lib/flows/serialize'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'

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

/** Loose match: same host is a match; an exact URL match wins over it. */
function matchesMcpEndpoint(serverUrl: string, endpoint: string): 'exact' | 'host' | null {
  try {
    const a = new URL(serverUrl)
    const b = new URL(endpoint)
    if (a.host !== b.host) return null
    return a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') ? 'exact' : 'host'
  } catch {
    return null
  }
}

/**
 * Create a real agent per imported n8n AI Agent cluster and swap its id into
 * the graph's agent steps. MCP tool sub-nodes bind to the org connection whose
 * server URL matches the n8n endpoint; app tools bind by integration key.
 */
async function materializeImportedAgents(
  specs: N8nAgentSpec[],
  graph: FlowGraph,
  auth: AuthContext,
  warnings: string[],
): Promise<FlowGraph> {
  if (specs.length === 0) return graph
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    select: { id: true, name: true, serverUrl: true },
  })
  const idByPlaceholder = new Map<string, string>()
  for (const spec of specs) {
    const integrations = [...spec.integrations]
    for (const endpoint of spec.mcpEndpoints) {
      const exact = connections.find((c) => matchesMcpEndpoint(c.serverUrl, endpoint) === 'exact')
      const match = exact ?? connections.find((c) => matchesMcpEndpoint(c.serverUrl, endpoint) !== null)
      if (match) {
        integrations.push(match.name)
      } else {
        warnings.push(
          `Agent “${spec.name}”: no connected MCP server matches ${endpoint} — add it under Connections, then attach it to the agent.`,
        )
      }
    }
    const agent = await prisma.agentTask.create({
      data: {
        type: 'agent',
        agentType: 'CUSTOM',
        priority: 'MEDIUM',
        description: `Imported from n8n${spec.model ? ` (originally ran on ${spec.model})` : ''}.`,
        objective: spec.instructions,
        context: {},
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
        status: 'ACTIVE',
        visibility: 'shared',
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        metadata: {
          title: spec.name,
          description: `Imported from n8n${spec.model ? ` (originally ran on ${spec.model})` : ''}.`,
          model: DEFAULT_AGENT_MODEL,
          integrations,
          skills: [],
          icon: '',
        },
      },
    })
    await syncAgentConnectors(agent.id, auth.organizationId, integrations)
    idByPlaceholder.set(spec.placeholderId, agent.id)
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.type === 'agent' && idByPlaceholder.has(node.data.agentId)
        ? { ...node, data: { ...node.data, agentId: idByPlaceholder.get(node.data.agentId)! } }
        : node,
    ),
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
    let warnings = [...converted.warnings]
    let graph = await materializeImportedAgents(converted.agents, flowGraphSchema.parse(converted.graph), auth, warnings)
    // An n8n export never carries secrets (only {id, name} references into the
    // source instance), so instead of importing every external call red, bind
    // each unauthenticated http step to auth this org already has.
    const [mcpConnections, httpCredentials] = await Promise.all([
      prisma.mcpConnection.findMany({
        where: { organizationId: auth.organizationId, isActive: true },
        select: { id: true, name: true },
      }),
      prisma.httpCredential.findMany({
        where: { organizationId: auth.organizationId, status: 'verified' },
        select: { id: true, name: true, allowedHost: true },
      }),
    ])
    const bound = bindImportedHttpAuth(graph, { mcpConnections, httpCredentials })
    graph = bound.graph
    warnings = [...dropStaleAuthWarnings(warnings, bound.boundLabels), ...bound.notes]
    // The import report, persisted so it outlives the toast: every importer
    // note plus how many BLOCKING problems the converted graph starts with
    // (structure-only validation — connection-aware checks are the builder's
    // live job). The builder shows these in the Import notes panel until the
    // user clears them.
    const validation = validateFlowGraph(graph, { requireRunnable: false })
    const importNotes = {
      notes: warnings.map((message) => ({ code: 'IMPORT_NOTE', severity: 'warning', message })),
      blocking: validation.errors.length,
    }
    const flow = await prisma.flow.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        name: converted.name,
        status: 'DRAFT',
        graph: JSON.parse(JSON.stringify(graph)),
        trigger: JSON.parse(JSON.stringify(triggerFromGraph(graph))),
        ...(importNotes.notes.length || importNotes.blocking ? { importNotes } : {}),
      },
    })
    return { success: true, flow: serializeFlow(flow), warnings, blocking: importNotes.blocking, source: 'n8n' }
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
