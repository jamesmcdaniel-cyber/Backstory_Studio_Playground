import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { nativeFlowPackageSchema } from '@/lib/flows/native-package'
import { recordAudit } from '@/lib/audit'
import { extractFlowCapabilities, requiresCapabilityReview, summarizeCapabilities } from '@/lib/flows/import/capabilities'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { looksLikeN8nWorkflow, n8nToFlow, resolveN8nImportUrl, unwrapN8nPayload, type FlowImportNote, type N8nAgentSpec } from '@/lib/flows/import/from-n8n'
import { bindImportedHttpAuth, dropStaleAuthWarnings } from '@/lib/flows/import/bind-imported-auth'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { parseN8nInstanceUrl, type N8nInstanceRef } from '@/lib/flows/import/n8n-instance'
import { fetchWithHttpCredential, resolveHttpCredential } from '@/features/flows/http-auth'
import { readResponseTextLimited } from '@/lib/net/response-body'
import { activityMatchColumns, triggerFromGraph } from '@/lib/flows/trigger'
import { serializeFlow } from '@/lib/flows/serialize'
import { syncAgentConnectors } from '@/lib/connectors/agent-connectors'
import { DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'

const URL_IMPORT_MAX_BYTES = 5_000_000

const URL_IMPORT_MAX_REDIRECTS = 3

/** Fetch a user-supplied import URL server-side (browser CORS can't) — SSRF-guarded, size- and time-capped. */
async function fetchImportUrl(raw: string, auth: { organizationId: string; dbUser: { id: string } }): Promise<unknown> {
  // Redirects are followed manually so the SSRF guard re-runs on every hop —
  // a public URL must not be able to 302 into a private or metadata address.
  const trimmed = raw.trim()
  // A personal n8n instance's EDITOR url (singular /workflow/<id>, vs the
  // n8n.io gallery's /workflows/). It serves the login-walled editor app; the
  // workflow JSON lives behind /api/v1 and needs the instance's API key. With
  // a stored credential for that host the URL "just works"; without one, the
  // error says exactly which of the two fixes to take.
  const instance = parseN8nInstanceUrl(trimmed)
  if (instance) {
    return fetchFromN8nInstance(instance, auth)
  }
  let current = resolveN8nImportUrl(trimmed)
  let response: Response
  for (let hop = 0; ; hop++) {
    try {
      await assertPublicUrl(current)
    } catch (error) {
      throw new ApiError(error instanceof SsrfError ? error.message : 'That URL cannot be fetched.', 400, 'BAD_IMPORT_URL')
    }
    try {
      response = await fetch(current, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new ApiError('Could not reach that URL.', 400, 'BAD_IMPORT_URL')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || hop >= URL_IMPORT_MAX_REDIRECTS) {
        throw new ApiError('That URL redirects too many times.', 400, 'BAD_IMPORT_URL')
      }
      try {
        current = new URL(location, current).toString()
      } catch {
        throw new ApiError('That URL cannot be fetched.', 400, 'BAD_IMPORT_URL')
      }
      continue
    }
    break
  }
  if (!response.ok) throw new ApiError(`That URL answered ${response.status} — it must serve the workflow JSON.`, 400, 'BAD_IMPORT_URL')
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > URL_IMPORT_MAX_BYTES) throw new ApiError('That file is too large to import (5 MB max).', 413, 'IMPORT_TOO_LARGE')
  const text = await response.text()
  if (text.length > URL_IMPORT_MAX_BYTES) throw new ApiError('That file is too large to import (5 MB max).', 413, 'IMPORT_TOO_LARGE')
  try {
    return JSON.parse(text)
  } catch {
    // Say WHAT came back: "did not return JSON" reads as our bug when the URL
    // served a web page, and the person's next step differs by which it was.
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
      throw new ApiError(
        'That URL returned a web page, not workflow JSON. For n8n.io templates, paste the template page URL. ' +
          'For a workflow in your own n8n, use its ⋯ menu → Download and import the JSON file instead.',
        400,
        'BAD_IMPORT_URL',
      )
    }
    throw new ApiError('That URL did not return JSON. Link the raw workflow JSON, or an n8n.io template page.', 400, 'BAD_IMPORT_URL')
  }
}

/**
 * Fetch a workflow from a personal n8n instance using its stored API key.
 *
 * The key is an ordinary HTTP credential bound to the instance host, so
 * lookup, decryption, use-audit and host-binding all come from the credential
 * store — this function only chooses the credential and shapes the errors.
 */
async function fetchFromN8nInstance(
  instance: N8nInstanceRef,
  auth: { organizationId: string; dbUser: { id: string } },
): Promise<unknown> {
  // Own credential first, then a workspace-shared (legacy, userId null) one —
  // the same bindable set the flow editor's credential picker offers.
  const row = await prisma.httpCredential.findFirst({
    where: {
      organizationId: auth.organizationId,
      allowedHost: instance.host,
      status: { in: ['verified', 'error'] },
      OR: [{ userId: auth.dbUser.id }, { userId: null }],
    },
    orderBy: [{ userId: { sort: 'asc', nulls: 'last' } }, { lastVerifiedAt: 'desc' }],
    select: { id: true },
  })
  if (!row) {
    throw new ApiError(
      `That is a workflow in your n8n at ${instance.host}, which needs an API key to read. ` +
        'Either connect your n8n instance on the Credentials page (n8n → Settings → API to create a key), ' +
        'or use the workflow menu (⋯) → Download and import the JSON file.',
      400,
      'N8N_CREDENTIAL_REQUIRED',
    )
  }

  const credential = await resolveHttpCredential(row.id, auth.organizationId, {
    actorUserId: auth.dbUser.id,
    consumer: 'flows.import_url',
  })

  await assertPublicUrl(instance.apiUrl)
  let response: Response
  try {
    response = await fetchWithHttpCredential(
      { url: instance.apiUrl, init: { method: 'GET', headers: { accept: 'application/json' } } },
      credential,
      AbortSignal.timeout(15_000),
    )
  } catch {
    throw new ApiError(`Could not reach ${instance.host}.`, 400, 'BAD_IMPORT_URL')
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError(
      `Your n8n at ${instance.host} rejected the stored API key — it may have been revoked. ` +
        'Rotate it on the Credentials page (n8n → Settings → API).',
      400,
      'N8N_CREDENTIAL_REJECTED',
    )
  }
  if (response.status === 404) {
    throw new ApiError('That workflow was not found in your n8n — check the link.', 400, 'BAD_IMPORT_URL')
  }
  if (!response.ok) {
    throw new ApiError(`Your n8n answered ${response.status} for that workflow.`, 400, 'BAD_IMPORT_URL')
  }
  const text = await readResponseTextLimited(response, URL_IMPORT_MAX_BYTES, 'n8n workflow')
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('Your n8n returned something that is not workflow JSON.', 400, 'BAD_IMPORT_URL')
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
    payload = await fetchImportUrl(asRecord.url, auth)
  }
  payload = unwrapN8nPayload(payload)

  if (looksLikeN8nWorkflow(payload)) {
    const converted = n8nToFlow(payload)
    const agentWarnings: string[] = []
    let graph = await materializeImportedAgents(converted.agents, flowGraphSchema.parse(converted.graph), auth, agentWarnings)
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
    // The import report, persisted so it outlives the toast. Structured notes
    // (code/severity/nodeId anchoring) come straight from the importer; stale
    // credential-transfer notes drop once the binder authenticated their step;
    // agent-materialization and binder outcomes append as their own notes.
    // `blocking` counts the converted graph's validation errors (structure-only
    // — connection-aware checks are the builder's live job).
    const keptMessages = new Set(dropStaleAuthWarnings(converted.notes.map((note) => note.message), bound.boundLabels))
    const notes: FlowImportNote[] = [
      ...converted.notes.filter((note) => keptMessages.has(note.message)),
      ...agentWarnings.map((message) => ({ code: 'AGENT_MCP_UNMATCHED', severity: 'warning' as const, message })),
      ...bound.notes.map((message) => ({ code: 'AUTH_BOUND', severity: 'info' as const, message })),
    ]
    const warnings = notes.map((note) => note.message)
    const validation = validateFlowGraph(graph, { requireRunnable: false })
    const importNotes = { notes, blocking: validation.errors.length }
    const trigger = triggerFromGraph(graph)
    const flow = await prisma.flow.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        name: converted.name,
        status: 'DRAFT',
        graph: JSON.parse(JSON.stringify(graph)),
        trigger: JSON.parse(JSON.stringify(trigger)),
        ...(importNotes.notes.length || importNotes.blocking ? { importNotes } : {}),
        ...activityMatchColumns(trigger),
      },
    })
    // What the flow is asking to be ALLOWED to do, as distinct from whether it
    // converted cleanly. An imported workflow is executable code written by a
    // stranger; the notes above answer "will it work", and only this answers
    // "what will it do with my workspace's access".
    //
    // The flow is created as a DRAFT either way — it cannot run until someone
    // publishes it — so this informs that decision rather than blocking the
    // import and losing the author's work.
    const capabilities = extractFlowCapabilities(graph)
    await recordImportCapabilities(auth.organizationId, auth.dbUser.id, flow.id, capabilities)

    return {
      success: true,
      flow: serializeFlow(flow),
      warnings,
      blocking: importNotes.blocking,
      source: 'n8n',
      capabilities,
      requiresReview: requiresCapabilityReview(capabilities),
      capabilitySummary: summarizeCapabilities(capabilities),
    }
  }

  const parsed = nativeFlowPackageSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ApiError('That JSON is neither a Backstory flow package nor an n8n workflow export.', 400, 'UNRECOGNIZED_IMPORT')
  }
  const input = parsed.data
  const nativeTrigger = triggerFromGraph(input.flow.graph)
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
      trigger: JSON.parse(JSON.stringify(nativeTrigger)),
      ...activityMatchColumns(nativeTrigger),
    },
  })
  // Native packages get the same review. A flow exported from another
  // workspace is no more trustworthy than one exported from n8n — the format
  // says nothing about the author.
  const capabilities = extractFlowCapabilities(input.flow.graph)
  await recordImportCapabilities(auth.organizationId, auth.dbUser.id, flow.id, capabilities)

  return {
    success: true,
    flow: serializeFlow(flow),
    source: 'native',
    capabilities,
    requiresReview: requiresCapabilityReview(capabilities),
    capabilitySummary: summarizeCapabilities(capabilities),
  }
}, { permission: 'flow.write' })

/**
 * Record what an imported flow asked for, at import time.
 *
 * Written whether or not anyone reads the review screen: "who imported the flow
 * that turned out to have a public webhook, and did they see that it did"
 * is an incident question, and it cannot be reconstructed later from a graph
 * that has since been edited.
 */
async function recordImportCapabilities(
  organizationId: string,
  actorUserId: string,
  flowId: string,
  capabilities: ReturnType<typeof extractFlowCapabilities>,
): Promise<void> {
  await recordAudit({
    organizationId,
    action: 'flow.imported',
    actorUserId,
    resourceType: 'flow',
    resourceId: flowId,
    detail: {
      requiresReview: requiresCapabilityReview(capabilities),
      capabilities: capabilities.map((capability) => ({
        kind: capability.kind,
        risk: capability.risk,
        subjects: capability.subjects.slice(0, 20),
      })),
    },
  })
}
