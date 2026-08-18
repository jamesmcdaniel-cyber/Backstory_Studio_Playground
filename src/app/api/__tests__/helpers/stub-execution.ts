/**
 * The fake-provider seam for API route tests.
 *
 * Roughly twenty mutating handlers sit on the SKIPS list in
 * mutating-route-smoke.test.ts for one reason: invoking them would run a live
 * model, mint a live credential, or dial a live third party. There was no way
 * to say "run the handler, but stop at the boundary" — so nobody did, and gates
 * that live in those handlers (the free-tier ceilings, most visibly) were
 * enforced by code no test had ever executed.
 *
 * This module supplies the two boundaries that unblock most of them:
 *
 *  - {@link stubBackgroundExecution} pins the queue seam that already exists in
 *    the product (EXECUTION_MODE + BULLMQ_DISABLE) so a run route creates its
 *    row, reaches the dispatcher, and stops there. Nothing is monkey-patched:
 *    this is the same switch the Vercel/Fly deployments flip.
 *  - {@link startFakeNango} stands up a real HTTP server on localhost and points
 *    NANGO_HOST at it, so the Nango SDK makes a real request that never leaves
 *    the machine — and the recorded calls become the assertion that a gate did
 *    (or did not) let the request through.
 *
 * Plus the small allowance-seeding helpers, so a test can put an actor over a
 * free-tier ceiling without restating how each ceiling counts.
 *
 * Everything here is test-only. Nothing in this file is imported by product code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FREE_TIER_LIMITS, type RunKind } from '@/lib/usage/free-tier-limits'

/** One request a fake provider received, recorded for assertions. */
export interface RecordedCall {
  method: string
  path: string
  body: unknown
}

export interface FakeProvider {
  /** Base URL to point the client under test at. */
  url: string
  /** Every request the fake received, in order. */
  calls: RecordedCall[]
  /** Shut the server down and restore any env this helper changed. */
  close: () => Promise<void>
}

type Reply = { status?: number; json?: unknown }

/**
 * A localhost HTTP server that answers every request from `respond`.
 *
 * Deliberately a REAL socket rather than a module mock: the client under test
 * (axios inside the Nango SDK, fetch elsewhere) exercises its own serialization,
 * headers and error mapping, so a test proves the route's boundary behaviour
 * rather than the shape of a stub. It also means no `--experimental-test-module-mocks`
 * flag, which this repo's `npm test` script does not pass.
 */
export async function startFakeHttpProvider(
  respond: (call: RecordedCall) => Reply = () => ({ status: 200, json: {} }),
): Promise<FakeProvider> {
  const calls: RecordedCall[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        /* keep the raw string */
      }
      const call: RecordedCall = { method: req.method ?? 'GET', path: req.url ?? '/', body }
      calls.push(call)
      const reply = respond(call)
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.json ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/**
 * A fake Nango backend, wired in through NANGO_HOST.
 *
 * `POST /connect/sessions` answers the shape the SDK's `createConnectSession`
 * unwraps ({ data: { token, expires_at } }). Everything else answers `{}`.
 *
 * The recorded calls are the point: "the route refused BEFORE minting" is only
 * provable by observing that the mint never happened, and a route that returns
 * 429 for the wrong reason (a rate limiter, say) would still show a zero call
 * count — so tests should assert the response code AND the call count together.
 */
export async function startFakeNango(): Promise<FakeProvider & { token: string }> {
  const token = 'fake-connect-session-token'
  const provider = await startFakeHttpProvider((call) =>
    call.path.startsWith('/connect/sessions')
      ? { status: 200, json: { data: { token, expires_at: '2099-01-01T00:00:00.000Z' } } }
      : { status: 200, json: {} },
  )
  const previous = { key: process.env.NANGO_SECRET_KEY, host: process.env.NANGO_HOST }
  process.env.NANGO_SECRET_KEY = 'fake-nango-secret'
  process.env.NANGO_HOST = provider.url
  return {
    ...provider,
    token,
    close: async () => {
      await provider.close()
      restoreEnv('NANGO_SECRET_KEY', previous.key)
      restoreEnv('NANGO_HOST', previous.host)
    },
  }
}

/**
 * Stop agent and flow runs at the dispatch boundary.
 *
 * `queue` mode hands a run to BullMQ instead of executing it inline, and
 * `BULLMQ_DISABLE=true` makes the queue layer refuse before it opens a Redis
 * connection. A run route therefore does everything up to and including
 * creating its run row, then answers "worker disabled" — which is exactly the
 * observable a gate test needs: the row's existence proves the gate let the
 * request through, and no model was ever called.
 *
 * MUST be called at module scope, before the route (or anything importing
 * `@/lib/queue/config` / `@/lib/queue/execution-mode`) is imported: both flags
 * are read once, at module load, into module constants.
 */
export function stubBackgroundExecution(): () => void {
  const previous = { mode: process.env.EXECUTION_MODE, disable: process.env.BULLMQ_DISABLE }
  process.env.EXECUTION_MODE = 'queue'
  process.env.BULLMQ_DISABLE = 'true'
  return () => {
    restoreEnv('EXECUTION_MODE', previous.mode)
    restoreEnv('BULLMQ_DISABLE', previous.disable)
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * Put an actor exactly ON the daily run ceiling for `kind`.
 *
 * Writes `FREE_TIER_LIMITS[...]` rows stamped inside the current UTC day, which
 * is what checkDailyRunAllowance counts. Returns the number written so a test
 * can assert "no NEW row was created" against it.
 */
export async function fillDailyRunAllowance(
  prisma: any,
  args: { kind: RunKind; organizationId: string; userId: string; agentTaskId?: string; flowId?: string },
): Promise<number> {
  const limit = args.kind === 'agent' ? FREE_TIER_LIMITS.agentRunsPerDay : FREE_TIER_LIMITS.flowRunsPerDay
  for (let i = 0; i < limit; i += 1) {
    if (args.kind === 'agent') {
      await prisma.agentExecution.create({
        data: {
          agentTaskId: args.agentTaskId,
          organizationId: args.organizationId,
          userId: args.userId,
          status: 'completed',
          trigger: 'manual',
          agentType: 'CUSTOM',
          input: {},
        },
      })
    } else {
      await prisma.flowRun.create({
        data: {
          flowId: args.flowId,
          organizationId: args.organizationId,
          userId: args.userId,
          status: 'completed',
          input: {},
          trigger: { type: 'manual' },
        },
      })
    }
  }
  return limit
}

/**
 * Put a workspace exactly ON the connected-integration ceiling.
 *
 * Nango connections, NOT MCP connections: countableIntegrations excludes the
 * `mcp` plane by product decision, so seeding MCP rows would leave the actor
 * under the cap and quietly turn the test green for the wrong reason.
 */
export async function fillIntegrationAllowance(
  prisma: any,
  args: { organizationId: string; userId: string },
): Promise<number> {
  const limit = FREE_TIER_LIMITS.integrations
  for (let i = 0; i < limit; i += 1) {
    await prisma.nangoConnection.create({
      data: {
        organizationId: args.organizationId,
        userId: args.userId,
        connectionId: `fake-connection-${i}-${Math.random().toString(36).slice(2)}`,
        providerConfigKey: `fake-provider-${i}`,
        status: 'connected',
      },
    })
  }
  return limit
}

/** Build a JSON NextRequest the way Next hands one to a route handler. */
export function jsonRequest(NextRequest: any, path: string, method: string, payload?: unknown): any {
  return new NextRequest(new URL(`http://test${path}`), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  } as never)
}

/** Response body as JSON, falling back to text so a failure message is readable. */
export async function readJson(response: Response): Promise<any> {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
