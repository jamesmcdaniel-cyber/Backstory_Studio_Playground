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

## Strategic parity still open

The n8n inventory remains the source of truth in `docs/n8n-full-parity-audit-2026-08-25.md`. Universal n8n item/paired-item/binary semantics, arbitrary metadata-rendered nodes, hundreds of provider-specific nodes and credential schemas, the full Instance AI/Chat Hub/Computer Use product families, MCP workflow-management tools, source control, and external secret-manager breadth are product programs rather than hardening defects. They require explicit product scope and staged migrations; they were not relabeled as closed in this pass.

External deployment controls also remain operator-owned: production secret rotation, hosted database/Redis sizing, alert destinations, authenticated E2E credentials, and restore-drill credentials cannot be changed safely from this repository. Repository checks and runbooks detect or document those conditions.
