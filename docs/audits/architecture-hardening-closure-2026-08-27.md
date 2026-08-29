# Architecture hardening closure — 2026-08-27

This records the implementation pass following the QA, parity, and architecture audit. It distinguishes closed operational defects from strategic n8n-parity work; the latter is not represented as complete merely because a similarly named surface exists.

## Priority closures

1. **Atomic flow resume handoff — closed.** A valid callback now clears its one-time token and writes an encrypted outbox command in one tenant transaction. Outbox delivery uses a stable delivery job id, so database commit, Redis outage, and retry cannot silently lose or ambiguously duplicate the resume.
2. **Request-body resource bounds — closed.** Authenticated mutations and every raw public ingress stream actual bytes through a deadline and limit. Omitted or false `Content-Length` cannot bypass enforcement. A route-tree test prevents direct raw parsers from returning unnoticed.
3. **Durable webhook response mode — closed.** Last-node webhooks queue first and poll for only a bounded fast result. Slow runs return `202` plus a trigger-secret-protected result URL; execution no longer depends on the web request lifetime.
4. **Worker topology and capacity — closed.** Capacity is derived from the queues a pool actually consumes and their per-queue concurrency. Internal all-pool demand is 21 job slots plus two infrastructure connections. Health uses per-queue heartbeats; monitoring covers all interactive and batch queues, queue age/depth, missing consumers, and stalled jobs.

## Additional closures in the same pass

- Agent definition publishing and flow definition review are reachable from their editors rather than API-only.
- Flow copilot supports the complete native node-type allowlist, including `wait` and `note`.
- The served MCP endpoint supports current stateless `2026-07-28` discovery and mirrored-header validation while retaining legacy initialization clients.
- Browser CSP reports keep working with `application/csp-report` under the new body reader.
- Strict webhook replay headers are documented as opt-in for provider compatibility; trigger-secret authentication remains mandatory.
- The worker accepts either complete Anthropic or Qwen configuration instead of falsely requiring Anthropic when Qwen is viable.
- The vulnerable Prisma CLI transitive merge package is overridden to the patched major; `npm audit` is clean and Prisma client generation succeeds.
- The lint baseline is zero warnings.

## Parity closure status

The later parity pass closed the repository-owned runtime and architecture work
that was still actionable: universal item packets and lineage, binary metadata,
typed ports, node versions and graph migrations, settings enforcement, Data
Tables, hosted Forms, execution annotations, Compare Datasets, crypto/JWT/TOTP,
dynamic credentials, four external secret-manager adapters, management MCP,
native node discovery, public workflow/agent/eval SDK primitives, and OTLP
workflow tracing. The authoritative disposition is
`docs/audits/n8n-parity-closure-2026-08-27.md`.

This does **not** relabel Backstory as an n8n clone. Provider/node catalogue
breadth, arbitrary community-package loading, outer-graph cycles, unrestricted
expressions/shell/computer control, a hosted OAuth authorization server, LDAP,
Git environment synchronization, and multi-instance registry features are
explicit product or safety boundaries. Generic HTTP, MCP, connected-app, and
SDK extension surfaces are the supported abstraction; they are not described
as node-for-node parity.

External deployment controls remain operator-owned: production secret rotation,
hosted database/Redis sizing, collector and alert destinations, authenticated
E2E credentials, provider identities, staging load tests, and restore drills
cannot be safely completed from a repository session. The current checklist is
`docs/runbooks/qa-gap-ops-checklist.md`.

## 2026-08-28 content-repository follow-up

The Data Tables destination now opens on a governed Content Repository while
retaining typed tables as a secondary view. Agent knowledge uploads and new
workspace uploads share one scanned, quota-enforced storage/indexing path;
original bytes remain immutable and downloadable while the extracted text is
editable and versioned. Read-only connected-source actions can be materialized
as dated pull artifacts with bounded, redacted provenance and failed-pull
history. Availability is enforced in both keyword and pgvector retrieval, so a
disabled or non-ready asset cannot enter an agent or flow prompt.

The hardening pass also added optimistic edit conflict detection, retrieval
tenant/document scope checks, durable-original retention protection, deletion
cleanup, audit events, authenticated route coverage, database constraints, and
workspace-export/teardown compatibility. Repository lists use stable cursor
pagination and server-side filters rather than silently capping the catalogue,
and abandoned indexing states can be repaired after a bounded processing lease.
Migration
`20260828120000_content_repository` applies from zero with no Prisma drift; the
focused database and route suite passed 95/95 against a disposable PostgreSQL
database.
