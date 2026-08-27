# Backstory Studio

Backstory Studio is a focused AI-agent workspace: create agents, connect tools, run tasks, inspect live tool calls and errors, and ask follow-up questions about an execution.

## Product Surface

- `/dashboard`: agent list, grouped run activity, output, tool calls, errors, per-agent run history, and follow-up chat
- `/integrations`: Nango connected-account integrations and custom MCP servers
- `/connections`: custom per-org MCP server connections
- `/templates`: reusable agent templates and skills

## Architecture

- Next.js App Router owns the UI and authenticated API routes.
- Supabase owns user authentication.
- Prisma/PostgreSQL stores tenants, agents, executions, tool events, templates, and connection state.
- Fastify/BullMQ workers execute agent and flow runs across interactive and batch queue pools.
- Nango provides connected accounts and the provider APIs called by agents.
- Custom MCP servers can be added separately for specialized tools.
- Claude and/or a Qwen Anthropic-compatible endpoint plan tool calls and answer follow-up questions.

## Editions

This tree builds in two editions, selected by the single constant in
`src/lib/edition.config.ts`:

- **`internal`** (this repo) — the full platform.
- **`customer`** (`Backstory_customers`) — the customer-facing build. The AI
  template-generation pipeline and the cross-workspace operator console
  (`/admin`, catalogue review, staff administration, cost and domain ops) are
  gated off, and onboarding is two steps rather than three.

`Backstory_customers` is a mirror of this tree whose only permanent diff is that
constant, so `git merge upstream/main` carries every feature across cleanly.
Never import `EDITION` directly — use `isCustomerEdition()` from
`src/lib/edition.ts`.

Adding an internal-only surface is a deliberate decision: gate the route with
`internalOnly: true` and add it to `INTERNAL_ONLY_ROUTES` in
`src/app/api/__tests__/edition-gates.test.ts`, which fails the build on drift.
Page surfaces go in `CUSTOMER_BLOCKED_PREFIXES` in `src/lib/edition.ts`.

## Local Setup

```bash
cp .env.example .env.local
npm install
npm run db:push
npm run dev:all
```

The web app runs on `http://localhost:3000`; the worker health endpoint runs on `http://localhost:3002/health`.

Supabase projects must install [`supabase/handle-new-user.sql`](supabase/handle-new-user.sql) so every authenticated user receives a tenant and matching Prisma user record.

## Commands

```bash
npm run dev          # Next.js only
npm run dev:all      # Next.js plus the worker runtime
npm run check        # typecheck, lint, and production build
npm run db:migrate   # create a Prisma migration
npm run db:deploy    # apply migrations in production
```
