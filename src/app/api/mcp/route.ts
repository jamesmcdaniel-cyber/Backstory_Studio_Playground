import { startFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { authenticatePublicApi, publicApiJson, type PublicApiContext } from '@/lib/public-api/auth'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { apiLogger } from '@/lib/logger'
import {
  GET_RUN_TOOL,
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
  initializeResult,
  isNotification,
  parseRpcRequest,
  rpcError,
  rpcResult,
  toolResult,
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

/** Only published flows are exposed: a draft is not a promise to anyone. */
async function publishedFlows(auth: PublicApiContext): Promise<PublishableFlow[]> {
  const flows = await prisma.flow.findMany({
    where: {
      organizationId: auth.organizationId,
      status: 'ACTIVE',
      publishedGraph: { not: Prisma.JsonNull },
      ...agentVisibilityScope(auth.userId),
    },
    select: { id: true, name: true, description: true, trigger: true },
    orderBy: { name: 'asc' },
    take: 200,
  })
  return flows
}

async function callFlowTool(
  auth: PublicApiContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown[]; isError?: boolean }> {
  const flows = await publishedFlows(auth)
  const names = uniqueToolNames(flows)
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

async function dispatch(auth: PublicApiContext, method: string, params: Record<string, unknown>, id: RpcId) {
  switch (method) {
    case 'initialize':
      return rpcResult(id, initializeResult(SERVER_NAME, SERVER_VERSION))

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list': {
      const flows = await publishedFlows(auth)
      return rpcResult(id, { tools: [...describeFlowTools(flows), GET_RUN_TOOL] })
    }

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : ''
      if (!name) return rpcError(id, RPC_INVALID_PARAMS, 'tools/call needs a tool name.')
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      if (name === GET_RUN_TOOL.name) return rpcResult(id, await callGetRun(auth, args))
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
  // flows:run, because every tool this server exposes starts a run. A read-only
  // key listing tools it could never call would be a misleading catalogue.
  const auth = await authenticatePublicApi(request, 'flows:run')
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return publicApiJson(rpcError(null, RPC_PARSE_ERROR, 'Request body must be JSON.'), 200)
  }

  const parsed = parseRpcRequest(body)
  if (typeof parsed === 'string') {
    return publicApiJson(rpcError(null, RPC_INVALID_REQUEST, parsed), 200)
  }

  // A notification takes no response at all — answering one is a protocol
  // violation that some clients treat as fatal.
  if (isNotification(parsed)) return new Response(null, { status: 202 })

  const id = parsed.id ?? null
  try {
    return publicApiJson(await dispatch(auth, parsed.method, parsed.params ?? {}, id), 200)
  } catch (error) {
    apiLogger.error('MCP server call failed', {
      method: parsed.method,
      organizationId: auth.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    // The reason stays in the log: this response leaves our infrastructure for
    // someone else's client, and an internal message is not theirs to read.
    return publicApiJson(rpcError(id, RPC_INTERNAL_ERROR, 'The server could not complete that call.'), 200)
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
