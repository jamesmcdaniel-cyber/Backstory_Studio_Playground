# Architecture

## Runtime Boundary

There are two runtime roles:

1. **Next.js**: pages, authentication, CRUD APIs, integration management, execution inspection, and external trigger endpoints.
2. **Worker**: Fastify processes with BullMQ consumers. The internal edition has three interactive queues (manual agents, scheduled agents, flows) and three batch queues (template generation, model bench, activity backfill). `WORKER_POOL=interactive|batch|all` permits separate scaling; the customer edition has only the interactive queues.

Both runtimes report errors through `src/lib/observability/sentry.ts`; the worker initializes it at boot (tagged `process: worker`) and flushes on shutdown.

Nango owns connected accounts and proxies provider API calls for agent-facing tools; organizations can also add custom MCP servers. Model access goes through `src/lib/llm/model-runner.ts`, which uses the Anthropic Messages API directly for Claude and through DashScope's compatible endpoint for Qwen. `AGENT_MODEL` defaults to `claude-sonnet-5`, `SUMMARY_MODEL` to `claude-haiku-4-5`, and a deployment may configure Anthropic, Qwen, or both for cross-endpoint fallback. Worker boot refuses to consume jobs when neither provider is complete.

## Agent Execution

1. Runs are enqueued by `POST /api/agents/:id/execute` (manual), the BullMQ job schedulers reconciled in `agent-schedule-registrar.ts` (hourly/daily/weekly/cron), or `POST /api/agents/:id/trigger` (webhook, authenticated by a per-agent secret).
2. The worker loads the agent's Nango provider tools and custom MCP connections, then runs a model tool-calling loop (max `AGENT_MAX_TURNS`, default 16). Each tool call is persisted as a `WorkflowStep` and `WorkflowEvent`; token usage accumulates on the execution.
3. The loop always exposes an `ask_user` tool. When the model calls it, the run pauses: the provider-native transcript is persisted on the execution, status becomes `waiting_for_input`, and the question is stored as an `ExecutionMessage`.
4. `POST /api/executions/:id/reply` records the user's answer and enqueues a resume job; the worker replays the saved transcript, feeds the answer back as the tool result, and continues.
5. Output or failure is persisted on the execution and surfaced by Agent HQ. `POST /api/chat` answers follow-up questions about a finished run; `GET /api/usage` reports month-to-date token usage per organization.

`POST /api/agents/draft` turns a plain-language description into an agent configuration (structured output) and can create the agent directly.

## Flow Execution

The engine is five modules, not one function. `execute-flow.ts` orchestrates and owns admission (claiming a run, concurrency limits, graph/manifest resolution); `seed-run-state.ts` decides the position a run starts FROM (what already counts as done on a resume, patch, replay, pin, or override); `run-step-recorder.ts` and `run-action-step.ts` are the run's only two writers of step rows — the first for steps the interpreter decides, the second for steps the engine executes; `finalize-flow-run.ts` records what happened once the walk returns. They share one step counter, so the run panel orders rows as they actually happened.

Flows normally execute through the `flow-execution` BullMQ queue. Every run pins the graph it started with in `FlowRun.graphSnapshot`; loop/parallel bodies persist iteration outputs under `nodeId#index`, so a pause resumes from its cursor without repeating earlier side effects. Reply/approval resume callbacks consume their one-time token and write an encrypted outbox command in the same database transaction. The outbox then dispatches a stable, delivery-idempotent queue job, so a Redis outage cannot consume the callback without preserving the work.

Webhook `lastNode` response mode also uses the durable queue. It waits for a bounded fast-path result and otherwise returns `202` with a trigger-secret-protected result URL. No flow execution remains attached to an unbounded serverless request.

## Shared Server Utilities

- `src/lib/prisma.ts`: process-wide Prisma client
- `src/lib/server/auth.ts`: required Supabase user and tenant context
- `src/lib/server/api-handler.ts`: authenticated API wrapper and consistent errors
- `src/lib/server/request-body.ts`: streamed byte ceilings, UTF-8/JSON parsing, and read deadlines
- `src/lib/supabase/middleware.ts`: session refresh and page protection

All tenant data queries must include `organizationId` — enforced at runtime by a tenant guard on the shared Prisma client (`src/lib/tenant-guard.ts`): org-carrying models refuse reads/updates/deletes whose `where` lacks `organizationId`. Enumerated system-wide paths (cron sweeps, reapers, tenant resolution, worker-internal id-keyed writes) use the unguarded `systemPrisma` export, each with a justification comment. Routes without a Supabase session (webhooks, SCIM, public API, and MCP) each use their own bearer/signature/trigger-secret admission path and tenant resolution.

People.ai webhook deliveries are verified per-tenant: each organization has its own signing secret (`Organization.peopleAiWebhookSecret`, encrypted at rest), minted at connect time and rotatable by an org admin (`/api/peopleai/webhook-secret`); an org with a secret never accepts the global fallback secret.

## Core Data

`prisma/schema.prisma` contains organizations, users, agents, executions, execution messages, workflow steps/events, templates, Nango account mirrors, and custom MCP connections. Executions carry the resumable model transcript, token counts, and the model that ran them.

Organization deletion is complete: every org-owned model cascades via FK (WS-R4 closed the gaps — flows, custom signals, push subscriptions, knowledge, shared skills), and `teardownOrganization` (`src/lib/org-teardown.ts`) deprovisions external Nango resources and clears the org's Neo4j nodes before deleting the row. The daily retention cron prunes `run:`/`signal:` graph nodes in lockstep with the Postgres rows it deletes.

Knowledge and agent-memory retrieval rank in-database with pgvector: each carries an `embeddingVec vector(1024)` column with an HNSW cosine index, and retrieval is a `<=>` distance query over all of an org's rows (no in-memory scan / 500-row cap). Reads/writes go through raw SQL wrapped in `SET LOCAL search_path = public, extensions` so the `vector` type resolves on Supabase. The legacy `embedding Json` columns are still written for deploy-window safety and are slated to drop (see follow-ups).

## Testing

Most logic is unit-tested with `node:test` (`npm test`). API routes are additionally smoke-tested against a seeded pgvector Postgres database. Coverage tests enumerate the route tree and require each route to declare its auth/permission treatment; another static guard prevents raw routes from reintroducing direct, unbounded body parsers. CI also boots the real worker against Redis/Postgres, audits dependencies, applies migrations from zero, checks schema drift, runs CodeQL and gitleaks, and builds the production bundle.

CI runs the DB-backed suite **twice**: once as the owner with RLS off (the current production configuration), and once in the `rls` job as a distinct `NOBYPASSRLS` role with `DATABASE_RLS_ENABLED=true`. The second run is what keeps the tenant policies from being decoration — with the flag off every policy in the schema is inert, so nothing else executes them. It catches the defect class that is invisible from TypeScript: a path reading a parent-scoped model (flow run steps, workflow steps, execution messages) without tenant context, where PostgreSQL returns zero rows and no error and the data merely looks deleted.

## Known follow-ups (tracked tech debt)

- **Drop legacy embedding Json columns.** WS-R5 moved knowledge/memory retrieval to pgvector (`embeddingVec`); the `KnowledgeChunk.embedding` / `AgentMemory.embedding` Json columns are now write-only legacy, kept so the previous deployment's instances keep working during a rollout. Drop both in the next schema migration once no code reads them.
- **Re-embed NULL-vector rows after enabling embeddings.** The vector retrieval path excludes `embeddingVec IS NULL` rows, and the keyword fallback only runs when the query itself can't embed — so knowledge/memories ingested while `VOYAGE_API_KEY` was unset (or skipped by the dimension-guarded backfill) are searched by neither path once embeddings are configured. Add a re-embed pass over `embeddingVec IS NULL` rows (or a documented "re-index after enabling embeddings" step); there is no auto-reindex today.
- **Flow-editor state (partly closed).** `src/app/flows/[id]/page.tsx` was a 3,285-line component with 55 `useState` hooks, no reducer, and no tests. Undo/redo is now a typed reducer (`src/lib/flows/graph-history.ts`, pure and unit-tested) behind `useGraphHistory`, and share-link state is `useFlowSharing`; the page is down to 49 hooks and its behaviour has 25 tests. The stated blocker — "no React component-test harness exists" — is long stale: there are 34 `.test.tsx` files, 20 under `components/flows`. The remaining groups worth extracting the same way are runs/selection (canvas selection, statuses, highlights, zoom) and publish/version.

  Note for anyone adding tests here: Node's test runner globs its positional arguments, so `[id]` is a character class and **a test under a dynamic-route directory never runs** — the file is silently skipped and the run still exits 0. Flow-editor tests live in `src/app/flows/__tests__/`, and `src/lib/__tests__/test-discovery.test.ts` fails if one is added under a bracketed path again.
- **MCP transport consolidation.** `mcp-client.ts` and `backstory-mcp.ts` both implement JSON-RPC, SSE parsing, session handling, and the initialize handshake. They should collapse into one transport with pluggable auth.
- **Per-org credentials for built-in tools.** Slack, Granola, and Email are keyed to single global env vars, so every organization shares one account — acceptable single-tenant, blocking for multi-tenant. The per-user `Integration` table already exists and should hold these.
- **Tool-discovery caching.** `loadTools` runs `initialize` + `tools/list` against custom servers; discovery is cached and runs in parallel, but cache invalidation should continue to be monitored.
- **Frontend data layer.** Pages fetch with raw `fetch` + `useState` + `setInterval`; shared domain types now live in `src/lib/types.ts`, but a query cache (e.g. TanStack Query) would remove the hand-rolled polling, refetch-everything mutations, and the `AGENTS_CHANGED_EVENT` window-event bus.
