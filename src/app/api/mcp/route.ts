import { startFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { authenticatePublicApiAny, publicApiJson, type ApiScope, type PublicApiContext } from '@/lib/public-api/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { apiLogger } from '@/lib/logger'
import { parseFlowSettings } from '@/lib/flows/settings'
import { emptyGraph, flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'
import { loadRunValidationContext } from '@/lib/flows/run-validation'
import { activityMatchColumns, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { assertFlowEditable } from '@/lib/flows/access'
import { nativeNodeRegistry } from '@/lib/flows/node-registry'
import { publishFlowDraft, unpublishFlowDraft } from '@/lib/flows/publish-service'
import { recordAudit } from '@/lib/audit'
import { summarizeGraphChange } from '@/lib/flows/edit-summary'
import { ApiError } from '@/lib/server/api-handler'
import { readRequestJsonLimited, RequestBodyError } from '@/lib/server/request-body'
import { createDataTable, listDataTables } from '@/lib/data-tables/service'
import { DataTableToolClient } from '@/lib/data-tables/tools'
import { dataTableColumnsSchema, normalizeDataTableRow } from '@/lib/data-tables/schema'
import {
  GET_RUN_TOOL,
  MCP_MANAGEMENT_TOOLS,
  managementTool,
  managementToolsForScopes,
  describeFlowTools,
  uniqueToolNames,
  type PublishableFlow,
} from '@/lib/mcp/server/tools'
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  discoveryResult,
  initializeResult,
  isNotification,
  parseRpcRequest,
  rpcError,
  rpcResult,
  toolResult,
  validateMcpTransport,
  type RpcId,
} from '@/lib/mcp/server/rpc'

export const runtime = 'nodejs'

/**
 * The MCP server: this workspace's published flows, as tools any MCP client can
 * call.
 *
 * We have consumed MCP since the connections page shipped and never served it,
 * so everything built here was reachable only through our own UI — not from
 * Claude, not from a customer's own agent. This is the other direction.
 *
 * Deliberately built ON the public API's auth rather than beside it: same
 * bearer credential, same scopes, same visibility scope, same rate limit, same
 * token budget. An MCP client is a public-API client that speaks a different
 * envelope, and giving it its own admission path would mean two places to get
 * authorization right.
 */

const SERVER_NAME = 'backstory-studio'
const SERVER_VERSION = '1.0.0'
const MCP_MAX_BODY_BYTES = 1_000_000
const METHODS = new Set(['initialize', 'ping', 'server/discover', 'tools/list', 'tools/call', 'resources/list', 'prompts/list'])
const RESERVED_TOOL_NAMES = new Set([GET_RUN_TOOL.name, ...MCP_MANAGEMENT_TOOLS.map((tool) => tool.name)])

function mcpJson(body: unknown, status = 200, protocolVersion?: string): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
    },
  })
}

/** Only published flows are exposed: a draft is not a promise to anyone. */
async function publishedFlows(auth: PublicApiContext): Promise<PublishableFlow[]> {
  const flows = await prisma.flow.findMany({
    where: {
      organizationId: auth.organizationId,
      status: 'ACTIVE',
      publishedGraph: { not: Prisma.JsonNull },
      ...agentVisibilityScope(auth.userId),
    },
    select: { id: true, name: true, description: true, trigger: true, settings: true },
    orderBy: { name: 'asc' },
    take: 200,
  })
  return flows.filter((flow) => parseFlowSettings(flow.settings).availableInMcp)
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function scoped(auth: PublicApiContext, scope: ApiScope): boolean {
  return auth.scopes.has(scope)
}

async function visibleFlow(auth: PublicApiContext, flowId: string) {
  if (!flowId) return null
  return prisma.flow.findFirst({
    where: {
      id: flowId,
      organizationId: auth.organizationId,
      ...agentVisibilityScope(auth.userId),
    },
  })
}

async function callFlowTool(
  auth: PublicApiContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown[]; isError?: boolean }> {
  const flows = await publishedFlows(auth)
  const names = uniqueToolNames(flows, RESERVED_TOOL_NAMES)
  const flow = flows.find((entry) => names.get(entry.id) === toolName)
  if (!flow) {
    return toolResult(`No published flow is exposed as "${toolName}". Call tools/list for what is available.`, true)
  }

  const limited = await rateLimit(`public-flow-run:${auth.organizationId}`, {
    limit: 30,
    windowMs: 60_000,
    failureMode: 'closed',
  })
  if (!limited.ok) return toolResult('Too many flow runs — try again shortly.', true)

  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.userId)
  if (budget.over) return toolResult('This workspace has reached its monthly token budget.', true)

  // A flow that declares trigger fields is called with those fields as an
  // object; one that declares none takes the single free `input`. Both arrive
  // through the same parse the run API uses, so an MCP caller cannot reach a
  // shape the HTTP caller could not.
  const raw = 'input' in args && Object.keys(args).length === 1 ? args.input : args
  const run = await startFlowExecution({
    flowId: flow.id,
    organizationId: auth.organizationId,
    userId: auth.userId,
    input: parseFlowInput(raw),
  })
  return toolResult({
    flowRunId: run.flowRunId,
    status: run.status,
    output: run.output ?? null,
    // Said plainly, because a model reading this decides what to do next.
    note:
      run.status === 'succeeded'
        ? 'The run finished; `output` is its result.'
        : 'The run is still going. Call get_flow_run with this flowRunId to collect the result.',
  })
}

async function callGetRun(auth: PublicApiContext, args: Record<string, unknown>) {
  const flowRunId = typeof args.flowRunId === 'string' ? args.flowRunId.trim() : ''
  if (!flowRunId) return toolResult('get_flow_run needs a flowRunId.', true)

  // Scoped through the flow, so a run belonging to a flow this caller cannot
  // see is not readable by guessing its id.
  const run = await prisma.flowRun.findFirst({
    where: {
      id: flowRunId,
      organizationId: auth.organizationId,
      flow: { ...agentVisibilityScope(auth.userId) },
    },
    select: { id: true, status: true, output: true, error: true, startedAt: true, finishedAt: true },
  })
  if (!run) return toolResult(`No run "${flowRunId}" is visible to this key.`, true)

  return toolResult({
    flowRunId: run.id,
    status: run.status,
    output: run.output ?? null,
    error: run.error ?? null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  })
}

const createFlowArgs = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  graph: z.unknown().optional(),
  settings: z.unknown().optional(),
  visibility: z.enum(['private', 'shared']).default('shared'),
  folder: z.string().max(120).default(''),
})

const updateFlowArgs = z.object({
  flowId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  graph: z.unknown().optional(),
  settings: z.unknown().optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  folder: z.string().max(120).optional(),
  expectedUpdatedAt: z.coerce.date().optional(),
})

async function callManagementTool(
  auth: PublicApiContext,
  name: string,
  args: Record<string, unknown>,
) {
  const descriptor = managementTool(name)
  if (!descriptor) return null
  if (!scoped(auth, descriptor.requiredScope)) {
    return toolResult(`${name} requires ${descriptor.requiredScope}.`, true)
  }

  try {
    switch (name) {
      case 'list_flows': {
        const parsed = z.object({
          status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).optional(),
          query: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }).parse(args)
        const flows = await prisma.flow.findMany({
          where: {
            organizationId: auth.organizationId,
            ...agentVisibilityScope(auth.userId),
            ...(parsed.status ? { status: parsed.status } : {}),
            ...(parsed.query
              ? {
                  AND: [
                    {
                      OR: [
                        { name: { contains: parsed.query, mode: 'insensitive' as const } },
                        { description: { contains: parsed.query, mode: 'insensitive' as const } },
                      ],
                    },
                  ],
                }
              : {}),
          },
          orderBy: { updatedAt: 'desc' },
          take: parsed.limit,
          select: {
            id: true,
            name: true,
            description: true,
            status: true,
            version: true,
            visibility: true,
            folder: true,
            updatedAt: true,
            publishedGraph: true,
          },
        })
        return toolResult({
          flows: flows.map(({ publishedGraph, ...flow }) => ({ ...flow, published: publishedGraph != null })),
        })
      }

      case 'get_flow': {
        const { flowId } = z.object({ flowId: z.string().min(1) }).parse(args)
        const flow = await visibleFlow(auth, flowId)
        if (!flow) return toolResult(`No visible flow "${flowId}".`, true)
        return toolResult({
          id: flow.id,
          name: flow.name,
          description: flow.description,
          status: flow.status,
          version: flow.version,
          visibility: flow.visibility,
          folder: flow.folder,
          graph: flow.graph,
          settings: flow.settings,
          trigger: flow.trigger,
          published: flow.publishedGraph != null,
          updatedAt: flow.updatedAt,
        })
      }

      case 'create_flow': {
        const parsed = createFlowArgs.parse(args)
        const graph = flowGraphSchema.parse(parsed.graph ?? emptyGraph())
        const settings = parseFlowSettings(parsed.settings)
        const trigger = triggerFromGraph(graph)
        const flow = await prisma.flow.create({
          data: {
            organizationId: auth.organizationId,
            userId: auth.userId,
            name: parsed.name,
            description: parsed.description,
            graph: jsonValue(graph),
            settings: jsonValue(settings),
            trigger: jsonValue(trigger),
            visibility: parsed.visibility,
            folder: parsed.folder,
            ...activityMatchColumns(trigger),
          },
          select: { id: true, name: true, status: true, graph: true, settings: true, updatedAt: true },
        })
        await recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'flow.created',
          resourceType: 'flow',
          resourceId: flow.id,
          detail: { source: 'mcp' },
        }).catch(() => undefined)
        return toolResult(flow)
      }

      case 'update_flow': {
        const parsed = updateFlowArgs.parse(args)
        const flow = await visibleFlow(auth, parsed.flowId)
        if (!flow) return toolResult(`No visible flow "${parsed.flowId}".`, true)
        assertFlowEditable(flow, auth.userId)
        if (parsed.expectedUpdatedAt && flow.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime()) {
          return toolResult('The draft changed since expectedUpdatedAt; read it again before updating.', true)
        }
        const graph = parsed.graph === undefined ? undefined : flowGraphSchema.parse(parsed.graph)
        const trigger = graph
          ? preserveWebhookSecretHash(triggerFromGraph(graph, flow.trigger), flow.trigger)
          : undefined
        const result = await prisma.flow.updateMany({
          where: {
            id: flow.id,
            organizationId: auth.organizationId,
            ...(parsed.expectedUpdatedAt ? { updatedAt: parsed.expectedUpdatedAt } : {}),
          },
          data: {
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.description !== undefined ? { description: parsed.description } : {}),
            ...(graph ? { graph: jsonValue(graph) } : {}),
            ...(parsed.settings !== undefined ? { settings: jsonValue(parseFlowSettings(parsed.settings)) } : {}),
            ...(parsed.visibility !== undefined ? { visibility: parsed.visibility } : {}),
            ...(parsed.folder !== undefined ? { folder: parsed.folder } : {}),
            ...(trigger ? { trigger: jsonValue(trigger), ...activityMatchColumns(trigger) } : {}),
          },
        })
        if (!result.count) return toolResult('The draft changed concurrently; read it again before updating.', true)
        const updated = await visibleFlow(auth, flow.id)
        return toolResult({
          id: updated?.id,
          name: updated?.name,
          status: updated?.status,
          version: updated?.version,
          updatedAt: updated?.updatedAt,
        })
      }

      case 'delete_flow': {
        const { flowId } = z.object({ flowId: z.string().min(1) }).parse(args)
        const flow = await visibleFlow(auth, flowId)
        if (!flow) return toolResult(`No visible flow "${flowId}".`, true)
        assertFlowEditable(flow, auth.userId)
        await prisma.flow.delete({ where: { id: flow.id, organizationId: auth.organizationId } })
        await recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'flow.deleted',
          resourceType: 'flow',
          resourceId: flow.id,
          detail: { source: 'mcp', name: flow.name },
        }).catch(() => undefined)
        return toolResult({ deleted: true, flowId: flow.id })
      }

      case 'validate_flow': {
        const parsed = z.object({ flowId: z.string().min(1).optional(), graph: z.unknown().optional() })
          .refine((value) => Boolean(value.flowId) !== (value.graph !== undefined), 'Pass exactly one of flowId or graph.')
          .parse(args)
        const stored = parsed.flowId ? await visibleFlow(auth, parsed.flowId) : null
        if (parsed.flowId && !stored) return toolResult(`No visible flow "${parsed.flowId}".`, true)
        const graph = flowGraphSchema.parse(parsed.graph ?? stored?.graph)
        const context = await loadRunValidationContext(graph, {
          organizationId: auth.organizationId,
          userId: auth.userId,
        })
        const validation = validateFlowGraph(graph, {
          flowId: stored?.id,
          agents: context.agentRefs,
          toolCatalog: context.toolCatalog,
          httpCredentials: context.httpCredentials,
          credentialResolvers: context.credentialResolvers,
        })
        return toolResult(validation)
      }

      case 'publish_flow':
      case 'unpublish_flow': {
        const { flowId } = z.object({ flowId: z.string().min(1) }).parse(args)
        const actor = { flowId, organizationId: auth.organizationId, userId: auth.userId }
        const flow = name === 'publish_flow'
          ? await publishFlowDraft(actor)
          : await unpublishFlowDraft(actor)
        return toolResult(flow)
      }

      case 'list_flow_versions': {
        const parsed = z.object({
          flowId: z.string().min(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }).parse(args)
        if (!(await visibleFlow(auth, parsed.flowId))) return toolResult(`No visible flow "${parsed.flowId}".`, true)
        const versions = await prisma.flowVersion.findMany({
          where: { flowId: parsed.flowId, organizationId: auth.organizationId },
          orderBy: { version: 'desc' },
          take: parsed.limit,
          select: { version: true, note: true, summary: true, publishedAt: true, publishedBy: true },
        })
        return toolResult({ versions })
      }

      case 'restore_flow_version': {
        const parsed = z.object({ flowId: z.string().min(1), version: z.coerce.number().int().positive() }).parse(args)
        const flow = await visibleFlow(auth, parsed.flowId)
        if (!flow) return toolResult(`No visible flow "${parsed.flowId}".`, true)
        assertFlowEditable(flow, auth.userId)
        const version = await prisma.flowVersion.findFirst({
          where: { flowId: flow.id, organizationId: auth.organizationId, version: parsed.version },
          select: { graph: true },
        })
        if (!version) return toolResult(`Version ${parsed.version} does not exist.`, true)
        const graph = flowGraphSchema.parse(version.graph)
        const summary = summarizeGraphChange(flow.graph, graph)
        const trigger = preserveWebhookSecretHash(triggerFromGraph(graph, flow.trigger), flow.trigger)
        const updated = await tenantTransaction(auth.organizationId, async (tx) => {
          const next = await tx.flow.update({
            where: { id: flow.id, organizationId: auth.organizationId },
            data: {
              graph: jsonValue(graph),
              trigger: jsonValue(trigger),
              ...activityMatchColumns(trigger),
            },
            select: { id: true, updatedAt: true },
          })
          await tx.flowEditSnapshot.create({
            data: {
              flowId: flow.id,
              organizationId: auth.organizationId,
              graph: jsonValue(graph),
              ...(summary ? { summary: jsonValue(summary) } : {}),
              editedBy: auth.userId,
            },
          })
          return next
        })
        await recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'flow.edited',
          resourceType: 'flow',
          resourceId: flow.id,
          detail: { source: 'mcp', restoredFromVersion: parsed.version },
        }).catch(() => undefined)
        return toolResult({ ...updated, restoredFromVersion: parsed.version })
      }

      case 'list_flow_runs': {
        const parsed = z.object({
          flowId: z.string().min(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }).parse(args)
        if (!(await visibleFlow(auth, parsed.flowId))) return toolResult(`No visible flow "${parsed.flowId}".`, true)
        const runs = await prisma.flowRun.findMany({
          where: { flowId: parsed.flowId, organizationId: auth.organizationId },
          orderBy: { startedAt: 'desc' },
          take: parsed.limit,
          select: {
            id: true,
            status: true,
            degraded: true,
            costUsd: true,
            error: true,
            startedAt: true,
            finishedAt: true,
          },
        })
        return toolResult({ runs })
      }

      case 'list_node_types': {
        const { query } = z.object({ query: z.string().trim().max(100).default('') }).parse(args)
        return toolResult({ nodeTypes: nativeNodeRegistry(query) })
      }

      case 'run_flow': {
        const parsed = z.object({ flowId: z.string().min(1), input: z.unknown().optional() }).parse(args)
        const flow = await visibleFlow(auth, parsed.flowId)
        if (!flow || flow.status !== 'ACTIVE' || !flow.publishedGraph || !parseFlowSettings(flow.settings).availableInMcp) {
          return toolResult(`No MCP-enabled published flow "${parsed.flowId}" is visible to this key.`, true)
        }
        const limited = await rateLimit(`public-flow-run:${auth.organizationId}`, { limit: 30, windowMs: 60_000, failureMode: 'closed' })
        if (!limited.ok) return toolResult('Too many flow runs — try again shortly.', true)
        const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.userId)
        if (budget.over) return toolResult('This workspace has reached its monthly token budget.', true)
        const run = await startFlowExecution({
          flowId: flow.id,
          organizationId: auth.organizationId,
          userId: auth.userId,
          input: parseFlowInput(parsed.input),
          usePublished: true,
          trigger: { type: 'manual' },
        })
        return toolResult({ flowRunId: run.flowRunId, status: run.status, output: run.output ?? null })
      }

      case 'list_agents': {
        const parsed = z.object({
          query: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }).parse(args)
        const agents = await prisma.agentTask.findMany({
          where: {
            organizationId: auth.organizationId,
            status: { not: 'DELETED' },
            AND: [
              agentVisibilityScope(auth.userId),
              ...(parsed.query ? [{ OR: [
                { description: { contains: parsed.query, mode: 'insensitive' as const } },
                { objective: { contains: parsed.query, mode: 'insensitive' as const } },
              ] }] : []),
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: parsed.limit,
          select: { id: true, description: true, objective: true, status: true, visibility: true, folder: true, updatedAt: true },
        })
        return toolResult({ agents })
      }

      case 'list_credentials': {
        const ownerScope = { OR: [{ userId: auth.userId }, { userId: null }] }
        const [http, mcp, connectedApps] = await Promise.all([
          prisma.httpCredential.findMany({
            where: { organizationId: auth.organizationId, ...ownerScope },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, authType: true, allowedHost: true, status: true, userId: true, lastVerifiedAt: true },
          }),
          prisma.mcpConnection.findMany({
            where: { organizationId: auth.organizationId, isActive: true, ...ownerScope },
            orderBy: { name: 'asc' },
            select: { id: true, name: true, provider: true, serverUrl: true, authType: true, userId: true, grantedScopes: true },
          }),
          prisma.nangoConnection.findMany({
            where: { organizationId: auth.organizationId, ...ownerScope },
            orderBy: { providerConfigKey: 'asc' },
            select: { id: true, provider: true, providerConfigKey: true, connectionId: true, status: true, userId: true, grantedScopes: true },
          }),
        ])
        return toolResult({ http, mcp, connectedApps, secretsIncluded: false })
      }

      case 'list_folders': {
        const folders = await prisma.workspaceFolder.findMany({
          where: { organizationId: auth.organizationId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, updatedAt: true },
        })
        return toolResult({ folders })
      }

      case 'create_folder': {
        const { name: folderName } = z.object({ name: z.string().trim().min(1).max(60) }).parse(args)
        if (folderName.toLocaleLowerCase() === 'general') return toolResult('General is the built-in workspace folder.', true)
        const exists = await prisma.workspaceFolder.findFirst({
          where: { organizationId: auth.organizationId, name: { equals: folderName, mode: 'insensitive' } },
          select: { id: true },
        })
        if (exists) return toolResult('A workspace folder with that name already exists.', true)
        const folder = await prisma.workspaceFolder.create({
          data: { organizationId: auth.organizationId, name: folderName },
          select: { id: true, name: true },
        })
        return toolResult(folder)
      }

      case 'rename_folder': {
        const parsed = z.object({ folderId: z.string().min(1), name: z.string().trim().min(1).max(60) }).parse(args)
        const current = await prisma.workspaceFolder.findFirst({ where: { id: parsed.folderId, organizationId: auth.organizationId } })
        if (!current) return toolResult(`No workspace folder "${parsed.folderId}".`, true)
        if (parsed.name.toLocaleLowerCase() === 'general') return toolResult('General is the built-in workspace folder.', true)
        const duplicate = await prisma.workspaceFolder.findFirst({
          where: {
            organizationId: auth.organizationId,
            id: { not: current.id },
            name: { equals: parsed.name, mode: 'insensitive' },
          },
          select: { id: true },
        })
        if (duplicate) return toolResult('A workspace folder with that name already exists.', true)
        const folder = await tenantTransaction(auth.organizationId, async (tx) => {
          await tx.agentTask.updateMany({
            where: {
              organizationId: auth.organizationId,
              visibility: { not: 'private' },
              folder: { equals: current.name, mode: 'insensitive' },
            },
            data: { folder: parsed.name },
          })
          return tx.workspaceFolder.update({
            where: { id: current.id, organizationId: auth.organizationId },
            data: { name: parsed.name },
            select: { id: true, name: true },
          })
        })
        return toolResult(folder)
      }

      case 'delete_folder': {
        const { folderId } = z.object({ folderId: z.string().min(1) }).parse(args)
        const current = await prisma.workspaceFolder.findFirst({ where: { id: folderId, organizationId: auth.organizationId } })
        if (!current) return toolResult(`No workspace folder "${folderId}".`, true)
        const moved = await tenantTransaction(auth.organizationId, async (tx) => {
          const result = await tx.agentTask.updateMany({
            where: {
              organizationId: auth.organizationId,
              visibility: { not: 'private' },
              folder: { equals: current.name, mode: 'insensitive' },
            },
            data: { folder: null },
          })
          await tx.workspaceFolder.delete({ where: { id: current.id, organizationId: auth.organizationId } })
          return result.count
        })
        return toolResult({ deleted: true, moved })
      }

      case 'list_data_tables':
        return toolResult({ tables: await listDataTables(auth.organizationId) })

      case 'create_data_table': {
        const parsed = z.object({
          name: z.string().trim().min(1).max(120),
          description: z.string().max(2000).optional(),
          columns: z.unknown().optional(),
        }).parse(args)
        return toolResult(await createDataTable({ organizationId: auth.organizationId, userId: auth.userId, ...parsed }))
      }

      case 'update_data_table': {
        const parsed = z.object({
          tableId: z.string().min(1),
          name: z.string().trim().min(1).max(120).optional(),
          description: z.string().max(2000).optional(),
          columns: z.unknown().optional(),
          expectedVersion: z.coerce.number().int().positive().optional(),
        }).refine(
          (value) => value.name !== undefined || value.description !== undefined || value.columns !== undefined,
          'Pass at least one field to update.',
        ).parse(args)
        const table = await prisma.dataTable.findFirst({
          where: { id: parsed.tableId, organizationId: auth.organizationId },
        })
        if (!table) return toolResult(`No data table "${parsed.tableId}".`, true)
        if (parsed.expectedVersion && table.version !== parsed.expectedVersion) {
          return toolResult('The table schema changed; read it again before updating.', true)
        }
        const columns = parsed.columns === undefined ? undefined : dataTableColumnsSchema.parse(parsed.columns)
        if (columns) {
          const rows = await prisma.dataTableRow.findMany({
            where: { tableId: table.id, organizationId: auth.organizationId },
            take: 10_001,
            select: { id: true, data: true },
          })
          if (rows.length > 10_000) {
            return toolResult('Schema changes for tables above 10,000 rows require an export/migration.', true)
          }
          for (const row of rows) {
            try {
              normalizeDataTableRow(row.data, columns)
            } catch (error) {
              return toolResult(
                `Row ${row.id} is incompatible with the new schema: ${error instanceof Error ? error.message : String(error)}`,
                true,
              )
            }
          }
        }
        const updated = await tenantTransaction(auth.organizationId, async (tx) => {
          const result = await tx.dataTable.updateMany({
            where: {
              id: table.id,
              organizationId: auth.organizationId,
              ...(parsed.expectedVersion ? { version: parsed.expectedVersion } : {}),
            },
            data: {
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description.trim() } : {}),
              ...(columns !== undefined ? { columns: jsonValue(columns), version: { increment: 1 } } : {}),
            },
          })
          if (!result.count) throw new ApiError('The table schema changed; read it again before updating.', 409, 'DATA_TABLE_STALE')
          return tx.dataTable.findFirstOrThrow({
            where: { id: table.id, organizationId: auth.organizationId },
            select: { id: true, name: true, description: true, columns: true, version: true, updatedAt: true },
          })
        })
        await recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'data_table.updated',
          resourceType: 'data_table',
          resourceId: table.id,
          detail: { source: 'mcp', schemaChanged: columns !== undefined },
        }).catch(() => undefined)
        return toolResult(updated)
      }

      case 'delete_data_table': {
        const parsed = z.object({ tableId: z.string().min(1), confirmation: z.string() }).parse(args)
        const table = await prisma.dataTable.findFirst({
          where: { id: parsed.tableId, organizationId: auth.organizationId },
          select: { id: true, name: true },
        })
        if (!table) return toolResult(`No data table "${parsed.tableId}".`, true)
        if (parsed.confirmation !== table.name) return toolResult('confirmation must exactly match the current table name.', true)
        await prisma.dataTable.delete({ where: { id: table.id, organizationId: auth.organizationId } })
        await recordAudit({
          organizationId: auth.organizationId,
          actorUserId: auth.userId,
          action: 'data_table.deleted',
          resourceType: 'data_table',
          resourceId: table.id,
          detail: { source: 'mcp', name: table.name },
        }).catch(() => undefined)
        return toolResult({ deleted: true, tableId: table.id })
      }

      case 'data_table_get_rows':
      case 'data_table_insert_row':
      case 'data_table_update_row':
      case 'data_table_upsert_row':
      case 'data_table_delete_row': {
        const client = new DataTableToolClient(auth.organizationId, auth.userId)
        try {
          return toolResult(await client.executeTool('', name, args))
        } catch (error) {
          return toolResult(error instanceof Error ? error.message : 'Data-table operation failed.', true)
        }
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError) return toolResult(error.issues.map((issue) => issue.message).join('; '), true)
    if (error instanceof ApiError && error.status < 500) return toolResult(error.message, true)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return toolResult('A resource with that name already exists.', true)
    }
    throw error
  }
  return toolResult(`Unsupported management tool "${name}".`, true)
}

async function dispatch(
  auth: PublicApiContext,
  method: string,
  params: Record<string, unknown>,
  id: RpcId,
  modern: boolean,
) {
  switch (method) {
    case 'initialize':
      return rpcResult(id, initializeResult(SERVER_NAME, SERVER_VERSION, params.protocolVersion))

    case 'server/discover':
      return rpcResult(id, discoveryResult(SERVER_NAME, SERVER_VERSION))

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list': {
      const flows = scoped(auth, 'flows:run') ? await publishedFlows(auth) : []
      return rpcResult(id, {
        tools: [
          ...describeFlowTools(flows, RESERVED_TOOL_NAMES),
          ...(scoped(auth, 'flows:read') || scoped(auth, 'flows:run') ? [GET_RUN_TOOL] : []),
          ...managementToolsForScopes(auth.scopes),
        ],
        ...(modern ? { ttlMs: 60_000, cacheScope: 'private' } : {}),
      })
    }

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) return rpcError(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name.')
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      if (name === GET_RUN_TOOL.name) {
        if (!scoped(auth, 'flows:read') && !scoped(auth, 'flows:run')) {
          return rpcResult(id, toolResult('get_flow_run requires flows:read or flows:run.', true))
        }
        return rpcResult(id, await callGetRun(auth, args))
      }
      const management = await callManagementTool(auth, name, args)
      if (management) return rpcResult(id, management)
      if (!scoped(auth, 'flows:run')) {
        return rpcResult(id, toolResult(`Running "${name}" requires flows:run.`, true))
      }
      return rpcResult(id, await callFlowTool(auth, name, args))
    }

    // Declared so a client that probes them gets an empty list rather than a
    // "method not found" it may treat as a broken server.
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })

    default:
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method "${method}".`)
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) {
    return mcpJson(rpcError(null, RPC_INVALID_REQUEST, 'Origin is not allowed.'), 403)
  }

  // This is one protocol endpoint with three independently scoped planes.
  // Admission accepts any flow scope; tools/list hides unavailable tools and
  // tools/call checks the selected tool again before it acts.
  const auth = await authenticatePublicApiAny(request, ['flows:read', 'flows:write', 'flows:run'])
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await readRequestJsonLimited(request, MCP_MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyError && error.status === 413) {
      return publicApiJson({ error: { code: error.code, message: error.message } }, 413)
    }
    return publicApiJson(rpcError(null, RPC_PARSE_ERROR, 'Request body must be JSON.'), 200)
  }

  const parsed = parseRpcRequest(body)
  if (typeof parsed === 'string') {
    return publicApiJson(rpcError(null, RPC_INVALID_REQUEST, parsed), 200)
  }

  const transport = validateMcpTransport(parsed, request.headers)
  if (!transport.ok) return mcpJson(transport.error, transport.status)

  // A notification takes no response at all — answering one is a protocol
  // violation that some clients treat as fatal.
  if (isNotification(parsed)) return new Response(null, { status: 202 })

  const id = parsed.id ?? null
  if (transport.era === 'modern' && !METHODS.has(parsed.method)) {
    return mcpJson(rpcError(id, RPC_METHOD_NOT_FOUND, `Unknown method "${parsed.method}".`), 404, transport.protocolVersion)
  }
  try {
    return mcpJson(
      await dispatch(auth, parsed.method, parsed.params ?? {}, id, transport.era === 'modern'),
      200,
      transport.protocolVersion,
    )
  } catch (error) {
    apiLogger.error('MCP server call failed', {
      method: parsed.method,
      organizationId: auth.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // The reason stays in the log: this response leaves our infrastructure for
    // someone else's client, and an internal message is not theirs to read.
    return mcpJson(rpcError(id, RPC_INTERNAL_ERROR, 'The server could not complete that call.'), 200, transport.protocolVersion)
  }
}

/**
 * Clients probe GET before opening a stream. We answer over plain POST rather
 * than SSE, so this says so instead of leaving the request hanging.
 */
export async function GET() {
  return publicApiJson(
    { error: { code: 'METHOD_NOT_ALLOWED', message: 'This MCP endpoint accepts JSON-RPC over POST.' } },
    405,
  )
}
