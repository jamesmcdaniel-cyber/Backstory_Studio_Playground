# n8n ↔ Backstory Studio — Platform-wide Parity Audit

**Date:** 2026-08-25
**Benchmark:** n8n master, cloned at audit time (`git clone --depth 1`).
**Scope:** the whole product surface, not flows. The existing
[`flows-n8n-parity-audit.md`](./flows-n8n-parity-audit.md) covers the flow engine, node
configuration, editor UX, import fidelity and the HTTP credential surface, across
audits dated 2026-07-27 → 2026-08-07. Everything there is treated as settled and is
not re-litigated here.

**Why this audit exists:** the flow audits were scoped to flows, and flows are no
longer where n8n's mass is. Enumerating the repo by file count rather than by
reputation puts the centre of gravity somewhere else entirely, and it is somewhere we
already compete.

---

## 0. Method

Areas were enumerated from the repository's own structure rather than from prior
knowledge — `packages/cli/src/modules/*` (backend feature modules),
`packages/frontend/editor-ui/src/features/*`, and `packages/@n8n/*` — then sized by
file count, then read far enough to describe accurately, then mapped against our
codebase with grep evidence. Counts are `.ts`/`.vue` files per directory.

Every verdict below is one of:

| Verdict | Meaning |
|---|---|
| **Ahead** | We have it and it is better built than theirs |
| **Parity** | Comparable capability, however differently expressed |
| **Partial** | The capability exists but stops short in a way that matters |
| **Absent** | No equivalent |
| **Off-mission** | Absent and should stay absent — with the reason |

---

## 1. The re-framing

n8n's largest module is no longer the workflow engine.

| Area | Files | What it is |
|---|---:|---|
| `cli/modules/agents` | 420 | A first-class agent product — memory, knowledge, skills, threads, sub-agents, publish |
| `editor-ui/features/ai` | 643 | AI surfaces in the editor |
| `@n8n/instance-ai` + `cli/modules/instance-ai` | 617 | AI assistant, credits, model gateway |
| `editor-ui/features/agents` + `@n8n/agents` | 652 | Agent UI and shared agent runtime |
| `@n8n/ai-workflow-builder.ee` | 278 | Build a workflow from a prompt |
| `cli/modules/mcp` + `mcp-registry` + `@n8n/mcp-browser` | 236 | MCP server, registry, browser |
| `cli/modules/n8n-packages` + `community-packages` | 225 | Node package distribution |
| `cli/modules/breaking-changes` | 95 | Detect and migrate deprecated node usage |
| `cli/modules/dynamic-credentials.ee` | 84 | Credentials resolved per-execution |
| `@n8n/computer-use` | 61 | Browser/computer control |
| `cli/modules/oauth-server` | 55 | n8n as an OAuth **provider** |
| `cli/modules/external-secrets.ee` | 53 | Vault / AWS / Infisical |
| `cli/modules/data-table` | 52 | Built-in database tables |
| `cli/modules/source-control.ee` + `git-connections.ee` | 60 | Git sync |
| `cli/modules/chat-hub` | 49 | Chat product over agents |
| `cli/modules/insights` | 36 | Analytics |
| `cli/modules/workflow-reviews.ee` (+59 UI) | 85 | Review/approval before a workflow ships |
| `cli/modules/agent-evals` | 21 | Agent evaluation |

**This changes what "parity" means.** The old framing — "n8n is a workflow tool with
307 integrations, we are an agent-first delivery surface, don't chase node count" —
was right in 2026-07 and is now only half right. n8n has spent its recent effort
building the product we are building. The integration-count argument still holds
(§6), but "they do workflows, we do agents" no longer describes the difference.

The good news, established below: on the **agent core** we are at or ahead of parity
in most places that matter, and ahead by a distance on evaluation. The gaps are
concentrated in **governance, credential plumbing, and one strategic omission**.

---

## 2. Agent platform — where we actually stand

n8n: ~1,070 files. Ours: `src/features/agents/`, `src/lib/agents/`, `src/lib/memory/`.

| Capability | n8n | Ours | Verdict |
|---|---|---|---|
| Agent runtime / execution | `agent-execution.service.ts` + orchestrator | `execute-agent.ts` | **Parity** |
| Skills | `agent-skills.service.ts` | 43 files; composition documented in memory | **Parity** |
| Knowledge / RAG | `agent-knowledge-*`, vector-store controllers | 61 files; pgvector with an HNSW index | **Ahead** — they store embeddings in a JSON column (`agent-memory-entry.entity.ts`); we have a real vector index |
| Long-term memory | `agents_memory_entries`: content, hash, supersession, status, embedding | `AgentMemory`: kind, embedding + `embeddingVec`, status, `timesUsed` | **Partial** — see §2.1 |
| Working memory / observations | `agents_observations`: markers (critical/important/info/completion), parent tree, token count, supersession | `reflection-sweep.ts` + `reflectAndRemember` | **Different design** — see §2.2 |
| Reflection | Observation reflector | Agents since day one; flows added later, pattern-triggered | **Parity** |
| Checkpoints | `agent-checkpoint.entity.ts` | Present in `execute-agent.ts` | **Parity** |
| Sub-agents | `sub-agents/` | 8 files | **Partial** — worth a dedicated look |
| Agent draft/publish | `agent-publish.service.ts` | Flows have `publishedGraph`; agents do not | **Absent** — see §2.3 |
| Agent test chat / test run | `agent-test-chat.service.ts`, `agent-test-run.service.ts` | — | **Off-mission** — standing product rule: unpublished flows *are* test mode, there is no second Run surface |
| Model catalog | `agent-model-catalog.service.ts` | Admin → Models | **Parity** |
| Trace export | `agent-session-langsmith-export.service.ts` | — | **Absent**, low value while our own trace plane exists |
| Credential dependency index | `agent-credential-index.service.ts` — which agents break if this credential dies | Credential governance + audit, but no dependency index | **Partial** — see §5.2 |
| **Agent evaluation** | `agent-evals`, 21 files: case generation, rating, runner | `src/lib/eval/`: bench, nightly, judge, baseline, shadow pairs, RAG evals, trajectory checks, pinned judge | **Ahead, substantially** |

### 2.1 Memory is scoped to the agent, not to the thing it is about

Their memory row is keyed `(agentId, resourceId)` with a unique index on
`(agentId, resourceId, contentHash)`. Ours is keyed by agent alone.

For a sales product this is the more consequential of the two differences. "What did
we learn about **Acme**" is a per-account question, and every memory we hold is
currently filed under the agent that happened to learn it. The dedup index is the
smaller half of the same gap: we can store the same learning twice.

**Recommendation:** add a nullable `resourceId` (+ `contentHash` unique index) to
`AgentMemory`. Additive, no migration of meaning, and it makes account-scoped recall
expressible.

### 2.2 No bounded working memory

Their observations are a within-run ledger: markered, tree-structured, token-counted,
supersedable. Ours is an LLM reflection pass that emits durable memory proposals.

These solve different problems and ours is the more useful *output* — it produces
something a human can approve. Theirs solves something we do not solve at all:
keeping a long run's context bounded, with a token budget and explicit supersession,
rather than letting it grow. Worth knowing about before the first very long-running
agent makes it urgent.

### 2.3 Agents cannot be drafted

Flows have a draft/`publishedGraph` split that the earlier audit correctly called a
place we are **ahead** of n8n. Agents do not have it: editing an agent edits the live
agent. n8n added `agent-publish.service.ts`.

Given that agents act through the user's own accounts and can write to real systems,
this is the one asymmetry in our own model that is hard to defend.

---

## 3. The strategic omission: we are an MCP client, not an MCP server

n8n ships both directions — `McpTrigger` (be a server), `McpClient` (consume one),
plus a 150-file `mcp` module, a `mcp-registry`, `mcp-apps`, and an
`agent-mcp-access.controller.ts` that governs which agents may reach which servers.

We have `src/app/api/mcp-connections/*` — the client — and nothing that serves.
Confirmed: no `tools/list` or `tools/call` handler exists anywhere under
`src/app/api`.

This is worth flagging above every other gap in this document because of what the
product is for. The stated north star is an external delivery surface for People.ai
Sales AI. The delivery surface for AI capability, in 2026, is an MCP server. Every
skill, flow and agent we have built is reachable only through our own UI; none of it
is reachable from Claude, from ChatGPT, from a customer's own agent, or from n8n
itself — while n8n has made itself reachable from all of them.

We already have the two hard parts: an OAuth-shaped credential model and a tool
registry (`tool-planes.ts`, `resolveFlowToolExecutor`) that resolves a named tool to
an executor with an entitlement check. Serving MCP is largely a protocol adapter over
machinery that exists.

**Recommendation: rank this first.** It is the highest strategic return of anything
in this audit, and it is not a large build.

---

## 4. Node and parameter system

| Capability | n8n | Ours | Verdict |
|---|---|---|---|
| Typed parameter reader | `INodeProperties`, 24 types | `tool-schema.ts` — $ref, anyOf/oneOf, allOf, enums, formats, bounds, defaults (shipped 2026-08-25) | **Parity** for the types we use |
| `resourceLocator` (By ID / By URL / From list) | Yes | — | **Absent** — see §4.1 |
| `resourceMapper` (fetch destination schema, map field-by-field) | Yes | — | **Absent** |
| `loadOptions` per field | Per-parameter, automatic | Generic "pick from a list", and not for MCP/People.ai planes | **Partial** |
| `collection` / `fixedCollection` ("Add option"/"Add item") | Yes | Optionals fold, but nested objects and arrays-of-objects still fall back to a JSON textarea | **Partial** |
| Type-aware condition operators | Per-type operator sets | `condition-ops.ts` (shipped 2026-08-25) | **Parity** |
| Per-node settings | alwaysOutputData, executeOnce, retryOnFail, maxTries, waitBetweenTries, onError, notes, notesInFlow | Advanced-params manifest — plus per-node `timeoutMs`, which they only have workflow-wide | **Ahead**, except `notesInFlow` |
| Note shown on the canvas node | `notesInFlow` | Note is stored and editable; the canvas node never renders it | **Absent**, trivial |
| **`typeVersion` + breaking-change migration** | `typeVersion` per node + a 95-file registry of detection rules, transformations and a user-facing report | Flow-level `version` for publishing; nothing per node | **Absent** — see §4.2 |

### 4.1 resourceLocator is the shape of the remaining argument problem

A People.ai MCP argument reads, verbatim: *"The internal People.ai ID of the record to
analyze. Use find_account or find_record_by_crm_id to obtain this."* The schema is
telling the user to go run a different tool by hand and paste the result back.

That is exactly what `resourceLocator` exists to remove: one control with By ID / By
URL / From list, storing `{value, cachedResultName}` so the UI can show "Acme Corp"
where the wire carries `18234`. It is the single highest-value remaining item in the
node-configuration area, and it subsumes the loadOptions gap.

### 4.2 We have no answer to changing a node's meaning

n8n stamps every node with a `typeVersion`, and `breaking-changes` is the machinery
around it: rules that detect deprecated usage in saved workflows, migrations that
transform them, and a report the user can act on.

We have neither half. If we change what a node's `data` means, every saved flow
silently reinterprets under the new meaning, with no detection and no report. We have
been able to get away with this because the graph schema has mostly grown additively —
that is a property of our history, not a property of our design.

This is an architecture decision with migration consequences, not a ticket.

---

## 5. Credentials and identity

| Capability | n8n | Ours | Verdict |
|---|---|---|---|
| Encryption at rest, key rotation | `encryption-key-manager` | `secrets.ts` v2 envelopes, dual-read rotation, rotation script | **Parity** |
| External secret providers | `external-secrets.ee`, 53 files — a *credential field* can reference a vault path | `key-source.ts` — Vault and AWS KMS, for the master key only | **Partial** — see §5.1 |
| Dynamic / runtime credentials | 96 files — credentials computed per execution, per caller | — | **Absent** |
| n8n as an OAuth **provider** | `oauth-server` (55) + consent + `token-exchange` (30) + `oauth-jwe` | `public-api/client-credentials.ts` — machine-to-machine only, no authorization-code flow, no consent screen | **Partial** |
| SSO SAML / OIDC | `sso-saml`, `sso-oidc` | Okta SAML + OIDC | **Parity** |
| LDAP | `ldap.ee` | — | **Off-mission** — SaaS; SSO covers the demand |
| Credential audit / revocation | — | Revocation spine, credential grant/rotation/use audit, PII egress recording | **Ahead** |

### 5.1 External secrets stop at the master key

Ours resolves *one* secret from Vault/KMS: `ENCRYPTION_KEY`. Theirs lets any
credential field be a reference into a secret store, so the credential value itself
never lives in the database.

For a customer with a security team, "your platform holds our Salesforce token, but
encrypted" and "your platform holds a *pointer* to our Salesforce token" are different
answers to a procurement question. Worth knowing which one we are choosing.

### 5.2 No credential dependency index

`agent-credential-index.service.ts` answers "what breaks if this credential is
revoked". We can answer "who used this credential" from the audit trail after the
fact; we cannot answer it before. Given how much of the credential governance program
already exists, this is a small addition to it, not a new system.

---

## 6. Governance and operations

| Capability | n8n | Ours | Verdict |
|---|---|---|---|
| Analytics / insights | `insights` (36) — collection, compaction, pruning | Adoption analytics (`src/lib/adoption/`) | **Parity** |
| Audit log | Yes | Yes, extensive | **Parity** |
| Log streaming to SIEM | `log-streaming.ee` (18), syslog client | — | **Absent** — a procurement checkbox for enterprise |
| Secret redaction in logs | `redaction` (18) | `logging/redact.ts`, structural, two independent defences | **Ahead** |
| **Git sync / source control** | `source-control.ee` + `git-connections.ee` (60) — push/pull workflows and credentials to a repo, environments | — | **Absent** — see §6.1 |
| **Change review before ship** | `workflow-reviews.ee` (26) + 59 UI files — reviewer inbox, eligibility, lifecycle | Runtime approvals (a tool call pauses for a human); no review gate on publishing | **Absent** — see §6.2 |
| Provisioning | `provisioning.ee` (21) | Invitations, domain-based access, teammates gate | **Parity** |
| OpenTelemetry | `otel` (21), `@n8n/otel` | Sentry; no OTel exporter | **Partial** |
| Queue / workers | `orchestration.ee` | Fly worker, queue mode live | **Parity** |
| Scheduler | `@n8n/scheduler` (90) | Cron + cadence layer | **Parity** |
| Task runners (out-of-process code execution) | `task-runner`, `task-runner-python` | In-process sandboxed code node | **Partial** — deliberate; revisit only if untrusted code becomes a product surface |
| Multi-instance registry / version history | `instance-registry`, `instance-version-history` | — | **N/A** — single-tenant-per-org SaaS |

### 6.1 Git sync is the enterprise gap I would rank second

n8n lets a customer put workflows under version control and promote between
environments. We have flow versions and a restore path, which is the *inner* loop.
The outer loop — dev → staging → prod as a reviewed, diffable, revertible artifact —
does not exist.

We are better positioned than n8n for this than it looks: `serialize.ts` already
produces a stable JSON representation, and the export/import path is well-tested. The
work is the git plumbing and an environment model, not a serialization format.

### 6.2 Nothing reviews a flow before it goes live

Our approvals are runtime gates: a *running* agent pauses before a write. n8n's
workflow reviews are a change process: a human approves the *definition* before it can
ship.

For a platform where a published flow runs on a schedule against real customer
systems, and where the owner invariant is enforced at four layers, the absence of a
review gate on publishing is a notable asymmetry — we are careful about who *is* an
owner and casual about what an owner can ship without a second pair of eyes.

---

## 7. Capabilities we do not have and should not build

Listed with the reason, so they stop being re-discovered as gaps:

| Area | n8n | Why not |
|---|---:|---|
| Node package distribution | `n8n-packages` + `community-packages` (225) | We are not a node marketplace. Our catalogue admits *workspace-contributed skills and templates*, sanitized at snapshot — a different and, for this audience, better trade |
| 307 integration node folders | 307 | Settled in the 2026-07 audit and still correct: the plane model (native / Nango / MCP / People.ai) beats competing on node count. Depth per plane, not breadth |
| Computer use / browser control | `@n8n/computer-use` (61), `mcp-browser` (65) | Enormous surface, unclear demand for a sales delivery surface, and squarely against our sandbox posture |
| LDAP | `ldap.ee` | SSO covers the enterprise demand |
| Raw expression editor, `{{ }}` in the UI | Central to n8n | Standing product mandate. Plain-English chips are the equivalent surface |
| Execute Command / SSH / FTP nodes | Yes | Deliberate security posture, consistent with the SSRF guard and host-bound credentials |
| Ignore-SSL, proxy config on HTTP | Yes | Same, and already recorded in the flows audit §11 |
| Agent test-chat / test-run as a separate surface | `agent-test-*` | Standing mandate: there is one Run surface; unpublished *is* test mode |
| Multi-instance registry, version history | Yes | Self-hosted concerns; not our deployment model |

---

## 8. Where we are ahead

Not decoration — these are places where copying n8n would be a regression:

1. **Agent evaluation.** Their 21 files against our bench/nightly/judge/baseline/
   shadow-pairs/RAG harness with a pinned judge and trajectory checking. Not close.
2. **Vector storage.** pgvector with an HNSW index against embeddings in a JSON column.
3. **Credential governance.** Revocation spine, grant/rotation/use audit, PII egress
   recording, AI egress policy. They have encryption and external secrets; they do not
   have the audit spine.
4. **Structural log redaction.** Two independent defences (key name *and* value shape).
5. **Draft/publish for flows.** Already noted in the earlier audit; still true.
6. **Per-node timeouts.** Theirs is workflow-wide.
7. **Plain-English configuration.** The no-raw-token mandate is a genuine product
   advantage for a non-technical audience, not a limitation to apologise for.

---

## 9. Ranked recommendations

Ordered by return, not by size.

1. **Serve MCP** (§3). Highest strategic return in this document. Most of the
   machinery exists; it is a protocol adapter over `tool-planes.ts` plus the
   entitlement checks already written.
2. **`resourceLocator`** (§4.1). Closes the largest remaining usability gap in the
   most-used configuration surface, and subsumes the per-field loadOptions gap.
3. **Git sync / environments** (§6.1). The enterprise gap most likely to appear in a
   procurement conversation.
4. **Node `typeVersion` + a migration/report path** (§4.2). Architectural; the cost of
   not having it grows with every saved flow.
5. **Resource-scoped agent memory** (§2.1). Small, additive, and makes per-account
   recall expressible — directly aligned with what the product is for.
6. **Review gate before publish** (§6.2).
7. **Agent draft/publish** (§2.3).
8. **Credential dependency index** (§5.2). Small addition to a system that exists.
9. **External secret references per credential** (§5.1). Only if procurement asks.
10. **Log streaming to SIEM** (§6). Checkbox work; do it when a deal needs it.

Small enough to do at any time: render the node note on the canvas (`notesInFlow`),
nested object/array arguments as an "Add item" collection rather than a JSON textarea.

---

## 10. What this audit did not cover

Stated so the next pass knows where to start rather than re-deriving it:

- `@n8n/workflow-sdk` (312 files) and `engine-v2` — their next-generation execution
  model. Read it before any large engine change of our own.
- `@n8n/crdt` — collaborative editing internals, against our huddle/jam implementation.
- `chat-hub` (49) in detail — it may be closer to our Slack teammate surface than the
  name suggests.
- `instance-ai` (617 files across two packages) — the assistant and credit model.
- Their node-level test infrastructure, against ours.
