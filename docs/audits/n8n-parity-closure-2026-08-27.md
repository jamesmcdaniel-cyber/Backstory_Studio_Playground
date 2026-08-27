# n8n parity and architecture closure — 2026-08-27

## Current verdict

The repository-owned P0/P1 architecture and QA gaps identified by the
2026-08-25 audit are closed. Exact n8n parity is **not** claimed: Backstory now
has the runtime contracts and extension surfaces needed for its product, while
several n8n product families remain explicit product or safety boundaries.

This distinction matters. Generic HTTP, MCP, connected-app, Data Table, and SDK
coverage makes a capability available; it does not magically reproduce every
n8n node's parameters, credentials, triggers, or operational semantics.

## What shipped in the closure

- A universal `FlowItem[]` data plane with JSON, binary metadata, errors,
  metadata, paired-item lineage, typed connection families, and indexed ports.
- Per-node behavior versions, graph schema v2, deterministic graph migrations,
  stored-graph impact reporting, and migration UI/API.
- Enforced workflow settings for ordering, timeouts, concurrency, run-data
  retention, error workflows, caller restrictions, MCP exposure, and run
  persistence.
- Durable Data Tables with typed schemas, row CRUD/upsert/filtering, CSV
  import/export, UI, runtime operations, MCP operations, RLS, and audit events.
- Hosted Forms with typed public submission, rate/body limits, publish gates,
  and form-trigger execution.
- Compare Datasets plus SHA-2, HMAC, JWT HMAC sign/verify, and RFC-compatible
  TOTP data operations.
- Dynamic per-user credential resolvers with host/auth binding contracts and
  self-service ownership enforcement.
- AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, and Vault KV v2
  references for HTTP credentials, with encrypted bootstrap identity,
  path-scope enforcement, bounded caching, redaction, use/failure/grant/rotation
  audit, and key-rotation coverage.
- Execution annotations, 1–5 ratings, tags, bounded typed custom metadata,
  annotator attribution, indexed filtering, and review UI.
- A management MCP plane for flow CRUD, publish/unpublish, versions/restore,
  runs, validation, agents, redacted credentials, folders, Data Tables, and a
  searchable exhaustive native-node contract registry.
- `@backstory/sdk`: typed workflow/agent/tool/guardrail definitions, native
  graph round-trip validation, public API/MCP client, and bounded eval runner.
- Opt-in OTLP/HTTP lifecycle and connected web/queue/worker workflow spans.
- RLS and runtime-role grants for every Prisma model carrying a required
  `organizationId`, including the two omissions found by the final database
  suite (`flow_reviews` and `audit_stream_destinations`).

## Disposition of all 157 legacy matrix rows

The legacy CSV remains immutable evidence for the 2026-08-25 snapshot. Every
row has exactly one disposition below.

### Native coverage shipped or reverified

These IDs are closed for Backstory's supported contract. This is not a claim of
byte-for-byte n8n behavior where the old row was marked partial.

- Runtime: `RT-01`, `RT-03`–`RT-08`, `RT-12`, `RT-16`–`RT-18`, `RT-20`–`RT-25`
- Configuration: `CFG-01`–`CFG-09`, `CFG-11`, `CFG-13`–`CFG-24`
- Core nodes: `NODE-01`, `NODE-04`, `NODE-07`, `NODE-13`, `NODE-14`, `NODE-18`, `NODE-24`
- Integrations: `INT-06`, `INT-07`
- Editor: `ED-01`–`ED-13`, `ED-15`–`ED-17`, `ED-21`
- AI and agents: `AI-01`, `AI-06`, `AI-07`, `AI-15`, `AI-17`, `AI-18`
- MCP: `MCP-01`–`MCP-06`
- Credentials and security: `SEC-01`, `SEC-03`–`SEC-07`
- Platform: `PLAT-01`–`PLAT-05`, `PLAT-08`, `PLAT-10`, `PLAT-16`, `PLAT-17`

### Supported through a consolidated abstraction

These are closed as architecture gaps. Backstory deliberately exposes fewer,
more general primitives; the narrower n8n-specific behavior remains a product
difference and must not be relabeled exact parity.

- Runtime: `RT-09`–`RT-11`, `RT-13`–`RT-15`, `RT-19`
- Configuration: `CFG-10`, `CFG-12`
- Core nodes: `NODE-02`, `NODE-03`, `NODE-05`, `NODE-06`, `NODE-08`–`NODE-12`, `NODE-15`–`NODE-17`, `NODE-19`, `NODE-21`–`NODE-23`, `NODE-25`
- Integrations: `INT-01`–`INT-05`
- Editor: `ED-14`, `ED-18`–`ED-20`
- AI and agents: `AI-02`–`AI-05`, `AI-08`–`AI-14`, `AI-16`, `AI-19`
- Credentials and security: `SEC-08`
- Platform: `PLAT-07`, `PLAT-11`

Examples include explicit loop containers instead of graph back-edges, safe
template expressions instead of an unrestricted JavaScript data proxy, generic
HTTP/MCP for long-tail protocols and providers, a consolidated AI/agent plane
instead of 122 LangChain node entrypoints, and native import/export with
fidelity warnings instead of promising lossless n8n round trips.

### Explicit product or safety boundary

- `RT-02`: outer-graph cycles remain forbidden; loops are explicit and bounded.
- `NODE-20`: arbitrary host command execution is not offered by the hosted app.
- `INT-08`–`INT-10`: arbitrary community package loading and its package-policy
  machinery are excluded; external capability enters through scoped MCP, HTTP,
  connected apps, or the public SDK.
- `AI-20`: user-device shell, filesystem, CDP relay, and mouse/keyboard control
  are not granted to hosted agents.
- `SEC-02`: Backstory consumes OAuth and issues scoped client-credential tokens;
  it is not a general third-party authorization-code server.
- `PLAT-06`, `PLAT-15`: Git synchronization was explicitly withdrawn; native
  packages, immutable versions, review gates, restore, and deployment promotion
  are the supported lifecycle.
- `PLAT-09`: there is no n8n-style multi-instance registry in Backstory's hosted
  deployment model.
- `PLAT-12`: provider setup uses the connection and credential surfaces rather
  than n8n Quick Connect.
- `PLAT-13`: package/node policy infrastructure is unnecessary while arbitrary
  executable packages are excluded.
- `PLAT-14`: enterprise identity is SAML/OIDC plus SCIM and MFA, not direct LDAP.

`RT-26` remains `not-benchmark`: the audited n8n engine-v2 was experimental and
not queue-compatible at that commit, so it is not a stable acceptance target.

## QA evidence

- Fresh PostgreSQL database: all **111** migrations apply successfully.
- Prisma migration history versus schema: **no difference detected**.
- Database-backed suite: **4,161 tests**, **4,151 passed**, **0 failed**, **10
  skipped** for deliberately absent external environments.
- Focused route/RLS regression: **81/81 passed**.
- TypeScript: passed. ESLint: passed with zero warnings.
- `@backstory/sdk`: **5/5** tests, declaration/ESM build, and real Node ESM import
  passed.
- Production Next.js build and QuickJS/Pyodide WASM asset smoke: passed.
- Anonymous/security E2E across Chromium, Firefox, and WebKit: **18 passed**, **3
  API-key-dependent cases skipped**.
- `npm audit --audit-level=moderate`: **0 vulnerabilities**.
- `git diff --check`: passed.

The disposable local audit databases contain test data only and are removed at
the end of the audit.

## What remains operator-owned

Only external deployment evidence remains: apply migrations in staging and
production; deploy web/worker together; configure least-privilege external
secret identities; configure and inspect an OTLP collector; set monitoring and
Sentry destinations; validate production worker/Redis/Postgres sizing; run the
staging load test; enroll owner TOTP; supply authenticated E2E credentials;
complete the embedding backfill before dropping legacy JSON embeddings; rotate
or revoke real secrets; and resolve the three stale catalogue labels.

The executable checklist is `docs/runbooks/qa-gap-ops-checklist.md`.
