# Flows ↔ n8n Parity Audit

> **Superseded (2026-08-25):** The source-pinned full audit in
> [`n8n-full-parity-audit-2026-08-25.md`](./n8n-full-parity-audit-2026-08-25.md)
> replaces this document as the parity baseline. In particular, the claim below
> that all Tier 1/Tier 2 gaps were closed compared feature names and did not
> establish n8n item-lineage, node-version, parameter-system, or catalogue parity.

> **Status update (2026-07-27): all Tier 1 (§2) AND all Tier 2 (§3) gaps closed.**
>
> **Tier 1 (engine, §2):** §2.1 list-aware per-item step contract · §2.5a per-item error policy
> (skip/collect/fail on steps + loops) · §2.5b `flow.failed` org error-handler signal · §2.3 merge
> modes (append + combineByKey) · §2.2 Wait node (delay/until/webhook-resume) · §2.6 HTTP pagination
> + optimize-for-AI · §2.4 files-through-flows (download via `responseType: file` AND upload via
> multipart) · §2.7 polling trigger + Nango provider-event triggers + cron scale audit · §2.8 realtime
> run streaming + live agent-process streaming.
>
> **Tier 2 (UX, §3):** table+search output views · node disable toggle · resource picker (loadOptions
> parity) + curated actions · chip live-preview · run-history filters + load-run-into-editor · field-level
> undo · sticky notes · templates at the create path · multi-select + bulk ops · AI build assist
> (conversational CopilotPanel already shipped + new Ask-AI in the Code node).
>
> Each with engine/API + validation + editor UI + tests; full CI gate (migrate/drift/typecheck/lint/
> DB-backed tests/build) reproduced green before push. The only items NOT built are the audit's explicit
> "don't build" list (§4/§5): free-form canvas, 300-node library, raw `{{ }}` exposure, LangChain
> sub-node wiring, SQL/cartesian merge — deliberately off-mission. Raw per-token LLM streaming (vs the
> shipped event-level agent streaming) is the one remaining deeper follow-on.

> **See also (2026-08-25):** [`n8n-platform-parity-audit-2026-08-25.md`](./n8n-platform-parity-audit-2026-08-25.md)
> audits the surface OUTSIDE flows — agents, MCP, credentials, governance, node
> versioning — after enumerating n8n's repo by module size. This document remains the
> authority on the flow engine, node configuration and import fidelity.

**Date:** 2026-07-27
**Benchmark:** n8n master (`~/Downloads/n8n-master`) — engine (`packages/core`, `packages/workflow`), editor (`packages/frontend/editor-ui`), node ecosystem (`packages/nodes-base`, `@n8n/nodes-langchain`).
**Subject:** Backstory Studio flows — engine (`src/features/flows/`), graph/schema (`src/lib/flows/`), editor (`src/components/flows/`, `src/app/flows/`), integrations (`src/lib/nango/`, `src/lib/connectors/`, `src/features/agents/tool-planes.ts`).

**Framing:** n8n is the benchmark, not the target. The audit separates (a) deliberate architectural differences that are strengths, (b) genuine gaps ranked by how much they limit what users can build, and (c) areas where we are at or ahead of parity.

---

## 1. Architectural identity — deliberate differences, keep them

These are places where the platforms diverge by design. Copying n8n here would erode the product's identity (AI-agent-first delivery surface for sales workflows, plain-English UX):

| Dimension | n8n | Backstory flows | Verdict |
|---|---|---|---|
| Canvas | Free-form Vue Flow graph, x/y coords, manual edge drawing | Vertical chain designer (Zapier/Power-Automate style), structural wiring, no coordinates | **Keep.** Chain layout suits the non-technical audience; it eliminates the entire class of "spaghetti canvas" problems and makes auto-layout/minimap moot. |
| Data referencing | `{{ }}` expression language, JS sandbox, luxon/jmespath | Plain-English chips over canonical `{{token}}` storage; structured comparators only, never eval | **Keep.** This is the no-raw-token mandate working as intended. The chip layer + loud missing-token failures is genuinely friendlier than n8n's silent-undefined expressions. |
| Integration model | 307 node folders / 547 node classes / 405 credentials | 4 tool planes (native, Nango ×16, MCP, People.ai) behind two generic nodes (`tool`, `http`) + AI agent nodes | **Keep the plane model.** Competing on node count is unwinnable and off-mission. MCP is the leverage: n8n itself is converging on MCP (`McpClient`, `McpTrigger`). Depth per plane > breadth of planes. |
| AI layer | LangChain sub-node graph (models/memory/tools as typed canvas connections) | Agent runtime + skills composed into prompts; `ai` op node (ask/extract/categorize/summarize/score) | **Keep.** Wiring memory/tools as canvas nodes is n8n retrofitting agents onto a DAG editor. Owning the agent runtime is cleaner. |
| Draft/publish | Single active workflow; history is EE | Draft graph vs `publishedGraph`, versions, restore-into-draft | **Ahead.** n8n doesn't have a real draft/publish split. |

---

## 2. Tier 1 — Engine-semantics gaps (limit what can be built at all)

### 2.1 No list/item pipeline between nodes ⬅ biggest structural gap
- **n8n:** every node consumes/emits `INodeExecutionData[][]` — items flow natively, with `pairedItem` lineage, per-item errors, and every transform node (Filter, Sort, Limit, Split Out, Aggregate, Summarize, Remove Duplicates, Compare Datasets) operating item-wise for free.
- **Ours:** single-value outputs (`interpret.ts`); items exist only inside `loop` bodies and `code` `each` mode, derived heuristically (`loopItems` — arrays or `items|records|results|data` keys, newline/comma splits).
- **Consequence:** "fetch 200 leads → filter → enrich each → dedupe → batch-write" — the archetypal sales automation — forces everything through loop containers or code nodes. Per-item error handling (skip the 3 bad rows, keep the 197 good ones) is impossible; one bad item takes the branch down.
- **Recommendation:** don't adopt `[{json,binary}]` wholesale. Introduce a first-class **list-aware step contract**: outputs tagged as lists, downstream steps declare `perItem: true`, engine maps automatically with per-item error policy (`skip | collect | fail`). The existing 13 `data` ops become list-aware for free. This is the single highest-leverage engine investment.

### 2.2 No Wait / Delay / resume-by-URL
- **n8n:** Wait node (interval, specific time, **resume webhook**, **resume form**) with `$execution.resumeUrl`, `WaitTracker` timer resumes, timing-safe resume tokens. Waiting is a first-class execution state usable mid-flow for external systems.
- **Ours:** `waiting` status exists and the resume machinery is solid (atomic claim, replay of completed steps, loop-iteration keying — `execute-flow.ts:277-455`) but it is only reachable via `humanReview`, agent-assist, and approvals. There is **no time wait, no webhook-resume node** (grep-confirmed absent).
- **Consequence:** "send proposal → wait 3 days → if no reply, nudge" and "wait for DocuSign callback" can't be expressed. For a sales platform these are core sequences, not edge cases.
- **Recommendation:** a `wait` node with `mode: duration | until | webhook` is mostly plumbing you already have — durations piggyback on the cron dispatcher (a `resumeAt` column + dispatch scan), webhook-resume mints a per-run token URL reusing the trigger-secret pattern. High value / moderate cost.

### 2.3 No multi-input Merge
- **n8n:** Merge v3 — `append`, `combineByFields` (join by matching key!), `combineByPosition`, `combineAll`, `combineBySql`, `chooseBranch`.
- **Ours:** `join` is a single-input passthrough (Gumloop "Join Paths"); `parallel` branches reconverge only by downstream steps referencing each branch's output via chips.
- **Consequence:** "pull Salesforce contacts + pull HubSpot contacts → merge by email" needs a code node. `combineByFields` is the one users will actually miss.
- **Recommendation:** extend `join` (or add `merge`) with `append` and `combineByKey` modes. Skip SQL/cartesian modes.

### 2.4 No binary/file pipeline
- **n8n:** `IBinaryData` per item, storage modes (filesystem/S3/DB), signed URLs, and a whole node family (Extract From File, Convert To File, Spreadsheet, Compression, Edit Image); HTTP node downloads to binary / uploads binary.
- **Ours:** files exist only as run-form inputs (`StoredFile`, 10 MB, Supabase bucket) with text extraction; step outputs are JSON-only; HTTP form-data explicitly rejects file parts (`http.ts:145`); `storage.ts` docstring already calls step-output files "future".
- **Consequence:** "download the attachment → parse the CSV → upload the report to Drive" is impossible end-to-end.
- **Recommendation:** this is your green-lit **files workstream** — the design should be *file references flowing as tokens* (StoredFile id + metadata chips), not base64-in-JSON. Needed: HTTP `responseType: file` → StoredFile; tool/HTTP steps accepting a file-reference arg; parse-file data ops (CSV/XLSX/PDF-text). Skip image editing/compression.

### 2.5 Error handling: no per-item tolerance, no error workflow
- **n8n:** `onError: continueErrorOutput` routes *failed items* to an error branch while good items continue; global **error workflows** catch failed/crashed executions; auto-deactivation of repeatedly-crashing workflows.
- **Ours:** per-node `onError stop|continue|route` + retries + timeouts is genuinely good (and simpler than n8n's), but error output is a single `{error, input}` object, and there is no org-level "when any flow fails, do X" (grep-confirmed absent).
- **Recommendation:** per-item error policy falls out of 2.1. For error workflows, you have a cheaper primitive already: add a `flow.failed` signal to `KNOWN_SIGNALS` and emit it from the failure path in `execute-flow.ts` — an org "on failure" flow becomes a signal-triggered flow with zero new concepts. This is a near-free win.

### 2.6 HTTP node: no pagination, no batching/rate-limiting
- **n8n:** pagination modes (update-param-per-page, follow-next-URL, completion conditions, max pages, inter-request interval) + batching (`batchSize`, `batchInterval`) + response-format `file` + "Optimize Response for AI" (CSS-selector/field trimming before feeding an agent).
- **Ours:** HTTP node has strong auth parity (see §4) but none of the above (engine map confirms absence).
- **Consequence:** any real API listing (Salesforce queries, HubSpot pages) needs a hand-rolled loop+variable counter.
- **Recommendation:** pagination is the highest-value missing HTTP feature for a CRM-centric product. "Optimize response for AI" is also cheap and directly on-mission (you already cap tool output at 50k chars — this generalizes it).

### 2.7 Triggers: no provider events, no polling, tick-based cron
- **n8n:** 103 trigger nodes; `webhookMethods.checkExists/create/delete` auto-register webhooks against external APIs; polling triggers with dedupe state; separate test vs production webhook URLs; Schedule Trigger with rich cron.
- **Ours:** `manual | schedule | webhook | signal`, with only 2 hard-coded signals (`flow.completed`, `agent.completed`); Nango webhooks are connection-lifecycle only, never per-record events; cron via a single Vercel-cron tick capped at `MAX_FLOWS_PER_TICK = 10`.
- **Consequence:** "when a deal moves stage in Salesforce / when a Slack message arrives" — the most common automation entry point — cannot start a flow. Everything is schedule-pull or generic-webhook-push.
- **Recommendation:** (a) generalize the signal registry into a per-provider event catalog fed by Nango webhook forwarding (Nango supports sync/forward events you currently ignore — `nango/webhook/route.ts`); (b) add a **polling trigger** (interval + tool-call + new-item dedupe cursor) — one generic node covers every read-tool in the catalog, which n8n needs 103 nodes to do. That's the plane-model advantage; use it. (c) Audit `MAX_FLOWS_PER_TICK=10` against expected org counts — it's a silent scale cliff.
- **Closed (2026-08-22):** (a) shipped as the activity-event substrate — a
  normalized `ActivityEvent` row (Slack Events API, per-workspace BYO app;
  Nango forward/sync) feeds an outbox-driven, exactly-once dispatcher
  (`src/lib/activity/dispatch.ts`) with a per-flow hourly throttle and
  loop-guard (selfOrigin/chainDepth) — "when a Slack message arrives" now
  starts a flow. See `docs/runbooks/activity-plane.md` for the ingestion →
  claim → run trace path, throttle/backfill/stale-claim operations, and
  Slack app setup steps; `docs/superpowers/specs/2026-08-21-activity-event-substrate-design.md`
  for the design. (b)/(c) still open, unaffected by this work.

### 2.8 No streaming
- **n8n:** `sendChunk` lifecycle hook streams agent tokens to the logs panel; queue mode streams worker→main→browser.
- **Ours:** 2s polling of `FlowRunStep` rows; agent feed also polled.
- **Recommendation:** medium priority. Polling is fine for step statuses; token streaming matters mainly for the agent/AI nodes' perceived latency. Supabase Realtime is already in the stack (Jam collab) — reuse that channel rather than building SSE.

---

## 3. Tier 2 — UX gaps (parity of experience, not capability)

Ranked by expected user pain:

1. **Output/input data viewers.** n8n: table / JSON / **schema** / binary / HTML modes, in-panel search, item pagination, virtualized schema view. Ours: raw JSON `<pre>` (drawer) + Markdown/HTML preview (run panel). A **table view** for array-of-object outputs and **search** are the big ones; the DataTree already is your schema view for mapping, so the gap is display, not mapping.
2. **Node disable toggle.** n8n: `d` key, per-node. Ours: absent — mock-data pinning is the only workaround. Trivial to add (`disabled` on node schema; scheduler treats as skipped passthrough) and disproportionately useful while debugging.
3. **Per-app actions in the palette.** n8n synthesizes "Slack → Send message / Update profile…" action lists from node metadata. Ours: connector → raw tool list with humanized names, args as JSON-schema forms. The tool specs already carry `inputSchema` + `isWrite`; curating top-N actions per Nango provider (label + pre-filled args template) would close most of the perceived distance without dependent-dropdown infrastructure. Dynamic `loadOptions`-style pickers (choose a channel/board from a live list) are the real n8n advantage here — consider a generic "pick from a read-tool" resource-locator for the top providers.
4. **Field-level undo.** Ours is structural-only (drawer edits bypass the undo stack). n8n undoes everything. Debounced field-edit checkpoints into the same stack would do.
5. **Expression/chip preview.** n8n shows resolved values live per segment as you type. Ours resolves only at run time (with good errors). The drawer already holds last-run data for the Input pane — evaluating chips against it for an inline preview is feasible and would materially reduce trial-and-error runs.
6. **Run history depth.** n8n: filters (status/date/tags/metadata/vote), retry-with-original-vs-saved, load-past-execution-onto-canvas (debug mode), execution annotations. Ours: activity page with status tabs; re-run-from-step + replayFrom (solid!). Biggest wins: date/trigger filters and a one-click "load this run into the editor" (you already store `graphSnapshot` per run — the data model is ready).
7. **Sticky notes / annotations.** Absent. Cheap in a chain layout (a note card type) and users do document flows in place.
8. **Templates at the create path.** You have 40 built-in templates + a unique auto-generation pipeline, but new flow = blank "Untitled flow". n8n funnels creation through a gallery + credential-setup wizard. Wiring your existing `TemplateProposal`/`AgentTemplate` surface into flow creation is the "data takes shape" onboarding step in the roadmap memory — the pieces already exist.
9. **Multi-select / bulk ops.** Absent (single `selectedId`). In a chain layout the need is smaller; bulk delete/duplicate of a selection range is enough — skip marquee/grouping.
10. **AI build assist.** n8n has a full build-mode chat (plan → diff → apply), Ask-AI in the code node, and error-view assistant. You have Checker "Fix with Copilot". Extending copilot to *generate/modify steps* conversationally is on-mission (AI-first product), but it's a feature program, not a gap patch.

---

## 4. At or ahead of parity — don't touch, or lean in

- **Partial execution:** `stopAfterNodeId` / `stopBeforeNodeId` / re-run-from-step with recorded-output replay ≈ n8n's `runPartialWorkflow2` + dirty tracking. Parity.
- **pinData / mock outputs:** explicit n8n mirror, implemented. Parity.
- **HTTP auth:** basic/bearer/custom/digest/OAuth1-signing/OAuth2 (cc + refresh w/ rotation)/header/query, host-bound credentials, SSRF re-checks per redirect hop, cross-origin auth-drop, live verification with status surfacing, cURL import that deliberately refuses to inline secrets. **Ahead** of n8n's generic-auth path on security posture (n8n has no host binding).
- **Code sandbox:** subprocess + Node Permission Model / Python AST gate + rlimits vs n8n's legacy in-process vm2 (their fix — task runners — is a whole separate service). **Ahead** for the managed-SaaS threat model.
- **Approval gates on write tools + audit events with arg hashing:** no n8n equivalent (their HITL is a form/Slack pattern, not a platform-level write gate). **Ahead**, and strategically aligned with enterprise sales delivery.
- **Live collaboration:** presence, cursors, elected persister, voice huddle. n8n EE has tab-level write locking only. **Ahead.**
- **Draft vs published graph + versions + restore + share links/roles:** ahead of n8n OSS (history is EE there), different but at least at parity with EE.
- **Auto-template generation from usage (graph-RAG):** no n8n analog. Unique.
- **n8n JSON export** (`to-n8n.ts`): unique escape-hatch; keep it current as node types grow.
- **Loud missing-token failures** vs n8n's silently-empty expressions: better default.

---

## 5. Recommended sequencing

Aligned with the existing green-lit workstreams (AI steps → subflows → knowledge → files) — these slot in as the engine/UX track beside them:

**P0 — unlocks new classes of flows**
1. List-aware step contract + per-item error policy (§2.1, §2.5a)
2. `wait` node (duration / until / webhook-resume) (§2.2)
3. HTTP pagination (+ optimize-for-AI trim) (§2.6)
4. `flow.failed` signal → org error-handler flows (§2.5b — near-free)

**P1 — closes the felt UX distance**
5. Merge modes: append + combine-by-key (§2.3)
6. Table view + search in output panes (§3.1); node disable toggle (§3.2)
7. Curated per-provider action catalog over existing tool specs (§3.3)
8. Polling trigger + provider event catalog via Nango event forwarding (§2.7)
9. Templates gallery at flow-create (§3.8 — assets already exist)

**P2 — polish / scale**
10. Files-through-flows (already a roadmap workstream; design as StoredFile references, §2.4)
11. Chip live preview against last-run data (§3.5); field-level undo (§3.4)
12. Streaming via Supabase Realtime (§2.8); run-history filters + load-run-into-editor (§3.6)
13. Cron dispatch scale audit (`MAX_FLOWS_PER_TICK`) (§2.7c)

**Explicitly not recommended** (n8n has it; you shouldn't): free-form canvas/minimap/auto-layout, a 300-node connector library, `{{ }}` expression language exposure, LangChain-style sub-node wiring, community-package npm installation, SQL/cartesian merge modes, image-editing/compression nodes, execution-order v0/v1 settings (your DAG scheduler is already order-correct).

---

## Appendix: evidence pointers

**Backstory:** engine `src/features/flows/execute-flow.ts`, `interpret.ts` (DAG scheduler, MAX_CONCURRENT_NODES=8, maxSteps=100), `context.ts` (token resolution, alias map, missing-token failures), `code-runner.ts`, `http-auth.ts`; schema `src/lib/flows/graph.ts` (20 node types, pinData), `dag-scheduler.ts`, `trigger.ts`; editor `src/app/flows/[id]/page.tsx`, `src/components/flows/{flow-canvas,step-drawer,step-card,run-panel,token-text-editor,data-tree,flow-picker,trigger-editor}.tsx`, catalog `src/lib/flows/builtin-catalog.ts`; integrations `src/lib/nango/provider-tools.ts` (16 providers, ~55 tools), `src/features/agents/tool-planes.ts`, `src/lib/connectors/registry.ts`; data model `prisma/schema.prisma:682-806`.

**n8n:** engine `packages/core/src/execution-engine/workflow-execute.ts` (items, paired items, continueErrorOutput, retryOnFail, partial-execution-utils), `packages/workflow/src/interfaces.ts` (INodeExecutionData, INodeTypeDescription), binary `packages/core/src/binary-data/`; wait/resume `packages/cli/src/wait-tracker.ts`, `webhooks/waiting-webhooks.ts`, `nodes-base/nodes/Wait/`; HTTP `nodes-base/nodes/HttpRequest/V3/Description.ts` (pagination/batching), `shared/optimizeResponse.ts`; merge `nodes-base/nodes/Merge/v3/actions/mode/`; editor `editor-ui/src/features/ndv/` (RunData table/json/schema/binary/html views, drag-to-map), `features/shared/nodeCreator/` (actions synthesis), `app/composables/useCanvasOperations.ts`; AI `packages/@n8n/nodes-langchain/`.

---

# Addendum — Node-configuration parity (2026-07-28)

The original audit compared **engine semantics** (§2, closed) and **editor UX** (§3).
This pass compares the **configuration surface of each node** — the fields a
builder can actually set — which is where the remaining distance now sits.

Method: every `data` object in `src/lib/flows/graph.ts` enumerated field by
field, against the equivalent n8n node's parameter + settings panel.

## 6. Universal node settings

n8n gives every node the same Settings tab. Ours, per node:

| n8n setting | Ours | Verdict |
|---|---|---|
| Notes | `note` on every node | Parity (ours always renders; n8n has a "display in flow" toggle) |
| Disable node | `disabled` node-level flag | Parity |
| On Error: stop / continue (regular output) / continue (error output) | `onError: 'stop' \| 'continue' \| 'route'` | Parity |
| Retry On Fail + Max Tries | `retries` (0–5) | Parity |
| **Wait Between Tries (ms)** | fixed `DEFAULT_RETRY_DELAY_MS`; `retryDelayMs` exists in `action-reliability.ts` but is not on the node schema | **Gap — trivial**: surface the existing knob |
| **Always Output Data** | absent | **Gap**: a node returning nothing halts the branch; n8n can emit an empty item so downstream still runs |
| **Execute Once** | implicit — fan-out is opt-in via `perItem` | Parity by inversion, no work needed |

## 7. The biggest gap: condition operators

`CONDITION_OPS` is 8 untyped operators — `eq, neq, gt, gte, lt, lte, contains,
matches` — shared by `condition`, `filter`, `switch`, and `data.filterArray`.

n8n's v2 conditions are **type-aware operator sets**: String (exists, is empty,
contains, does not contain, starts with, ends with, matches regex), Number (is
even/odd, …), Boolean (is true/false), Array (contains, length equals/gt/lt, is
empty), Object (is empty, has key), DateTime (is after/before/equals) — plus
**Ignore Case** and **strict vs loose type validation** toggles.

This is the single most-used configuration surface in either product, and ours
is the thinnest part of the schema. Concretely missing and commonly needed:
`isEmpty` / `isNotEmpty`, `exists` / `notExists`, `startsWith` / `endsWith`,
`notContains`, `isTrue` / `isFalse`, date comparison, and the case-insensitivity
toggle. **Recommend closing this first** — it is additive to `CONDITION_OPS`
plus the evaluator, needs no engine change, and unblocks four node types at once.

## 8. Per-node configuration gaps

| Node | Ours | Missing vs n8n | Weight |
|---|---|---|---|
| `data` op `compose` | passthrough only — returns its input structured | n8n's Set/Edit Fields **JSON mode**: build an object from named fields. The `fields` array already exists on the schema (used by `select`) and is not wired to `compose` | **High** — blocks the "hold a token for later" pattern |
| `transform` (Set) | `fields: {name, value}[]` | per-field **type** (string/number/boolean/array/object), **Include Other Input Fields** (all / selected / all-except), dot-notation toggle, ignore-conversion-errors | **High** |
| `join` (Merge) | `passthrough \| append \| combineByKey` + `key` | combine **by position**, **all combinations**, **include unpaired items**, more than 2 inputs, SQL mode | Medium |
| `loop` | `over`, `concurrency`, `itemError` | **batch size** (N items per iteration, not just concurrency), explicit "done" branch | Medium |
| `http` | method/url/query/headers/body/cookie/contentType/responseType/redirects/failOnHttpError/retries/timeout/pagination/optimizeForAi/credentialId | **pagination stop-condition** (n8n's "complete when": status code / expression / empty response — ours stops on `maxPages` or an empty page only), **request batching** (items per batch + interval) for rate-limited APIs, **include response headers/status**, **split response into items**, max-redirect count | Medium |
| `switch` | `cases[]`, implicit default | **send to all matching outputs** toggle, explicit configurable fallback output | Low |
| `subflow` | flowId/inputs/onError/retries/timeout/perItem | **wait for completion** toggle (fire-and-forget) | Low |
| `code` | language, mode (all/each), timeout | parity | — |
| `wait` | duration / until / **webhook** | parity (resume-by-URL shipped since the original audit) | — |

## 9. Item-shaping nodes we have no equivalent for

n8n ships these as first-class core nodes; our `DATA_OPS` covers neither:

- **Sort** — by field(s), asc/desc, or custom comparator.
- **Limit** — keep first/last N items.
- **Remove Duplicates** — by all fields / selected fields / compared against previous runs.
- **Aggregate** — collapse items into one (field-wise or whole-item list).
- **Summarize** — group by + sum/avg/count/min/max. The pivot-table node; no analog here and it is the one most often reached for in reporting flows.

`Split Out` is covered by `flatten` / `getItem`, and `Item Lists` by
`filterArray` / `select` / `trim`. Adding **sort**, **limit**, and **summarize**
as three new `DATA_OPS` would close most of the practical distance.

## 10. Triggers

`FLOW_TRIGGER_TYPES = manual | schedule | webhook | signal | poll`.

Gaps are in the **webhook trigger's configuration**, not the trigger set:
n8n exposes **response mode** (respond immediately / when last node finishes /
via a Respond-to-Webhook node), **webhook authentication** (basic / header /
none), raw-body passthrough, and a per-webhook path. Worth checking ours against
that list before calling triggers done.

## 11. Deliberate non-goals

Not gaps — do not close:

- **Ignore SSL issues** on HTTP. n8n has it; we shouldn't. The SSRF guard and
  host-bound credentials are a deliberate security posture (§4).
- **Proxy configuration** on HTTP — same reasoning, and no managed-SaaS demand.
- **Execute Once** — our fan-out is opt-in, so the default already is "once".

## 12. Recommended order

1. **Condition operators** (§7) — widest reach, additive, no engine change.
2. **`compose` object mode + `transform` field types** (§8) — the two that
   currently block real flows being built.
3. **`sort` / `limit` / `summarize` data ops** (§9).
4. **Retry wait + Always Output Data** (§6) — small, and both show up the moment
   someone builds against a flaky API.
5. Merge modes, loop batch size, HTTP pagination stop-condition (§8).

## 13. Status after the closing pass (2026-07-28)

Everything in §6–§10 is now implemented. Reference for what each landed as:

| Gap | Landed as |
|---|---|
| Condition operators (§7) | `CONDITION_OPS` 8 → 19, plus per-clause `ignoreCase`; unary ops hide their value box via `UNARY_CONDITION_OPS` |
| Compose object mode (§8) | `data.compose` builds an object from `fields`; passthrough when none declared |
| Set field types (§8) | `transform.fields[].type` + `includeOtherFields`, coerced by `coerceFieldType` |
| Merge modes (§8) | `combineByPosition`, `allCombinations`, `includeUnpaired` (opt-out for by-key, opt-in for by-position) |
| Loop batch size (§8) | `loop.batchSize` — the body sees an array of up to N items as the current item |
| HTTP pagination stop (§8) | `pagination.completeWhen` = `emptyPage` / `statusCode` / `pathMissing` |
| HTTP redirects (§8) | `maxRedirects`, threaded to the SSRF-checked hop loop |
| HTTP batching (§8) | `perItem.batchIntervalMs` — paces a fan-out against a rate-limited API |
| Switch all-matching (§8) | `switch.allMatches`; `EdgeResult.branch` accepts `string[]` |
| Subflow fire-and-forget (§8) | `subflow.waitForCompletion: false` dispatches and returns `{ started: true }` |
| Item-shaping nodes (§9) | `sort`, `limit`, `removeDuplicates`, `aggregate`, `summarize` data ops, in the step palette |
| Retry wait (§6) | `retryDelayMs` on every retryable node, threaded to all four retry sites |
| Always Output Data (§6) | `alwaysOutputData`, applied by a wrapper around the action executor |
| Webhook response mode (§10) | `trigger.responseMode: 'immediately'` returns 202 and runs in the background |
| Webhook auth (§10) | Already parity — `webhookSecretHash` is the header/secret check |
| HTTP response headers (§8) | Was never a gap — `FlowHttpOutput` always carried `headers`/`status`/`statusText`/`url` |

Every one is reachable from the editor: the operator/mode dropdowns render from
the shared enums, the new data ops have their own field editors, and the
node-level settings (retry wait, always-output-data, max redirects, batch size,
wait-for-subflow) live in the shared **Advanced parameters** panel.

Still deliberately absent, per §11: ignore-SSL and proxy on HTTP.

## 14. Execution and persistence re-audit (2026-08-02)

The representative mixed graph now has two contract layers: graph validation
and interpreter execution both cover a webhook trigger followed by an agent,
an outbound webhook, a plain HTTP request, a connected integration tool, and a
custom MCP tool. The graph is only publishable when the agent, both tool-plane
connections, HTTP credential, and webhook secret are present; the interpreter
test verifies resolved output is threaded through every step to the MCP result.

Built-in template contracts remain green: every graph parses; every executable
step is documented; every empty agent/connection slot has a binding; connector
requirements use real catalogue keys; and the three starter templates have no
workspace setup requirements. Templates that necessarily depend on a customer
system remain drafts with an explicit setup checklist rather than pretending to
be runnable with missing credentials.

This pass also closed three persistence seams found outside the node engine:

- Flow details (name, description, and folder) are now editable from the
  builder's Flow settings dialog and save through the same guarded flow writer.
- Canvas and settings edits are durably awaited in the edit timeline; History
  names the fields changed, while publish continues to atomically create the
  restorable `FlowVersion` snapshot.
- Sharing changes and webhook-secret rotation now return/propagate the new
  `updatedAt`, so the next canvas save does not fail its optimistic lock against
  the builder's own immediately preceding settings write.

## 15. Live end-to-end re-audit (2026-08-02)

§14 proves the contracts. This pass ran them: a scratch Postgres migrated from
zero, a seeded workspace, and one flow carrying a webhook trigger → HTTP request
→ integration tool (native plane) → MCP tool (People.ai plane) → agent → output,
driven through the real API routes with live endpoints (postman-echo, the live
People.ai MCP server, a live model). It found six defects that no unit or
contract test could reach, because each one lives *behind* a query the tests
never execute.

**All six are the same mistake:** a Prisma query on an org-carrying model with a
`where` that omits `organizationId`. The tenant guard throws on those at run
time — which is correct for a leak, but means the code path either 500s or, when
the call sits inside a `catch`, silently does nothing forever.

| Where | Symptom |
| --- | --- |
| `POST /api/flows/[id]/publish` | **Every publish 500'd.** The version-number lookup was unscoped. No flow could be armed, so webhook/schedule/signal/poll triggers were unreachable on any flow published after the regression. |
| `execute-flow` cancellation poll | Cancel flipped the run to `cancelling`; the interpreter's poll threw into `.catch(() => null)` and never saw it. **Cancelling a running flow did nothing.** |
| `http-auth` refresh-token rotation | A rotated OAuth2 refresh token was never persisted, so the next cold start reused a dead one. |
| `http-auth` credential health writes | `markCredentialResult` never wrote; the credential picker's verified/error state never moved after a run. |
| `PATCH /api/http-credentials` | Re-verifying a stored HTTP credential 500'd on both the success and failure branch. |
| `POST /api/nango/connections/[id]/verify` | Integration re-verification 500'd. |
| `syncAgentConnectors` | Every sync failed into a warning log, so agents permanently fell back to the `metadata.integrations` list instead of the typed rows. |

`src/lib/__tests__/prisma-where-org-scoped.test.ts` now fails the build on this
shape: any literal `where` on an org-scoped model that names no
`organizationId`. It is deliberately narrow — a `where` built in a variable or
carrying a spread is not statically decidable and is skipped rather than guessed
at — but every one of the defects above is exactly the shape it catches. Genuine
global-unique writes (the push-subscription endpoint) use `systemPrisma` with a
justification, as the guard's own docs prescribe.

Two more gaps closed in the same pass:

- **Webhook reply mode was unreachable.** The trigger route has always honored
  `responseMode: 'immediately'` (acknowledge, run in the background — the answer
  for senders that time out), but nothing in the product could set it: it was
  absent from the trigger editor, and the only other way in — a `trigger`-only
  `PUT /api/flows` — is reverted by the next canvas save, because the graph's
  trigger node is the source of truth for `Flow.trigger`. It is now a field on
  the webhook trigger editor, so it persists through the graph like every other
  trigger setting.
- **Restoring a version left no trace.** Restore rewrites the draft canvas
  exactly as a manual save does, but recorded no audit row, so History showed
  the canvas changing with nothing to explain it. It now records `flow.edited`
  naming the version it came from, and the panel renders "restored vN".

### Verified live, not merely typechecked

- All six node classes execute: HTTP (real request/response envelope),
  integration tool (`native:http`), MCP tool (live People.ai `find_account`,
  `get_account_status`, `ask_sales_ai_about_account`), agent (real model call),
  trigger, output.
- The external webhook path end to end: mint secret → publish → `POST
  /trigger` with `x-trigger-secret` → 202 accepted (immediate reply mode) →
  background run against the *published* graph, with the run row carrying
  `trigger: webhook` and a pinned graph snapshot. A wrong secret 401s; a
  trigger condition that fails skips the run without creating one.
- Settings round-trip (name, description, folder, visibility, trigger config)
  and survive a subsequent canvas save, including the webhook secret hash.
- Version history: publish → v1, edit → publish → v2, snapshot payload is the
  pre-edit graph, restore returns the draft to v1 and is logged, and a settings
  `PUT` cannot demote a published flow back to draft.
- All 11 built-in templates instantiate: the notes contract holds for every one,
  bindings resolve agents by name and connections by provider/tool, and the five
  that need no customer system are runnable with an empty or purely advisory
  setup checklist. The six that call Slack/a CRM stay DRAFT with a checklist and
  a validation error naming the exact unbound step — the intended signal, not a
  failure.

### Known behavior worth calling out

An MCP server that reports a miss *in band* — `isError: false` with an
`{ error: … }` payload, which is what People.ai returns for "record not found" —
produces a **succeeded** tool step. `flowToolOutput` only fails a step on
`isError: true`, so `onError` never fires and the empty field flows downstream,
where it surfaces as an opaque type error two steps later. The account-plan
template shows this: a nonexistent account name reaches `get_account_status`
with an empty `peopleai_account_id`. Templates that chain off a lookup should
gate on it; a general fix would mean second-guessing every MCP server's success
contract, which is a product decision rather than a bug.

## 16. Project-wide QA audit (2026-08-02)

A sweep beyond flows, driven the same way §15 was: real handlers, real
database, evidence rather than reading.

### The structural finding: mutating routes were never invoked

`route-smoke.test.ts` covers the GET surface and, for POST/PUT/PATCH/DELETE,
asserts only that each handler is wrapped in `withAuthenticatedApi`. Measuring
which handlers any test actually *calls*:

| method | invoked / total (before) | after |
| --- | --- | --- |
| GET | 48 / 62 | 52 / 62 |
| POST | 7 / 63 | 39 / 63 |
| PUT | 1 / 6 | 6 / 6 |
| PATCH | 0 / 7 | 7 / 7 |
| DELETE | 1 / 23 | 23 / 23 |

**90 of 99 mutating handlers were invoked by no test at all.** That is not an
abstract coverage number — it is precisely how `POST /api/flows/[id]/publish`
shipped 500ing on every call (§15): the handler was authenticated, so the
existing guard was satisfied, and nothing ever called it.

`src/app/api/__tests__/mutating-route-smoke.test.ts` closes it. Every mutating
handler is either invoked with a plausible body and asserted not to crash, or
carries a documented `SKIPS` entry (live model turn, external provider call,
multipart upload). Two completeness tests keep it honest: a new mutating handler
with neither a case nor a skip fails the build, and a skip entry for a handler
that no longer exists fails too. The unattended cron tick is included, since
nothing else calls it.

Invoking all of them found the code itself in good shape — 66 of 67 handlers
answered correctly on a first shallow pass, and a second pass driving full
create → read → update → delete lifecycles through agents, agent templates,
skills, flow templates (including versioning and restore), MCP connections, HTTP
credentials, signal subscriptions and org invitations came back clean. The gap
was the coverage, not the behavior.

### Defects found

**A view-only guest could read the webhook secret's hash.** Seeding every
secret-bearing column with a unique sentinel and grepping every read endpoint's
response found no plaintext anywhere — but `GET /api/flows` and
`GET /api/flows/[id]` echoed `trigger.webhookSecretHash`, because the stored
trigger JSON was serialized wholesale. Nothing client-side reads it (the builder
learns `hasSecret` from the trigger-secret route), and the rest of the codebase
already treats it as server-only: the mint route returns the plaintext exactly
once and never the hash, `preserveWebhookSecretHash` re-attaches it on save
precisely because the client is not expected to round-trip it, and the
anonymous-share sanitizer drops it. It reached everyone who can read the flow,
including cross-workspace guests on a view-only share link. `serializeFlow` now
strips it at the one wire boundary all three routes share.

**An unconfigured Nango returned "Internal server error".** `nangoApiError`
already maps "not configured" to a 503 `NANGO_UNAVAILABLE`, but every route
builds the client OUTSIDE the try/catch that applies it, so the bare `Error`
from `getNangoClient()` fell through to the generic 500 handler. Four routes
were affected (connections DELETE, verify, integrations, session-token).
`getNangoClient` now throws the typed error itself, and `nangoApiError` passes
an existing `ApiError` through instead of flattening it to a 502.

**The tenant-scope guard scan did not cover test files.** `main` was red when
this audit started: `FlowTemplateVersion` had just been added to
`ORG_SCOPED_MODELS`, and a DB test that had always queried it by id alone began
throwing. Test code uses the same guarded client, so the scan now includes
`__tests__` — which surfaced 13 more unscoped queries across the pgvector,
knowledge-ingest, agent-memory and flow-template-version suites, all latent
until their model joined the guard. A `tenant-guard-negative-test` marker opts
out the one place that is unscoped on purpose (the test asserting the guard
rejects an unscoped read).

### Verified healthy

- **The cron tick.** `/api/cron/dispatch` runs every 15 minutes and drives every
  scheduled agent and flow, poll trigger, due wait, outbox batch, approval reap
  and MCP health sweep — with no test at all before this pass. Exercised end to
  end: fail-closed auth (no secret and wrong secret both 401), a due scheduled
  flow dispatched and ran to `succeeded`, a due timer wait resumed, a run stuck
  48h in `running` was reaped, a second tick did not double-fire either, a failed
  agent dispatch left no execution stranded in `running`, and every sub-sweep is
  individually isolated so one failure cannot abort the tick. `/api/cron/retention`
  likewise.
- **No secret material in any response.** 15 read endpoints, 7 seeded sentinels,
  plus assertions that no ciphertext column and no secret hash is echoed.
- **Swallowed-failure surface.** Every DB call sitting inside a `.catch()` or a
  log-only `try/catch` was re-checked; after §15's fixes, all are correctly
  scoped. That shape is what made the earlier bugs invisible.

### Remaining gaps (not closed)

- **24 mutating handlers stay uncovered by design** — they make live model or
  provider calls (agent/flow execution, copilot, chat, librarian, drafting,
  Nango/Granola/MCP probes, multipart uploads). A fake-provider layer would let
  these run in CI; today they are only exercised by hand.
- **10 GET routes uncovered**: OAuth callbacks (`peopleai/callback`,
  `mcp-connections/oauth/callback`), status probes (`nango/status`,
  `peopleai/status`, `health`), `invitations/lookup`, `granola/notes/[id]`,
  `nango/integrations`, and the two catalogue reads. The callbacks are the
  interesting ones — they are the join points of every integration flow.
- **The queue plane is not in CI.** `EXECUTION_MODE=queue` and the BullMQ worker
  were verified by hand against a local Redis; nothing re-checks them.
- **UI is essentially untested above the component level.** There are component
  and hook tests, but no page-level or browser coverage in CI; the browser QA
  passes to date have been manual, with a temporary middleware bypass.
- **No agent-execution E2E in this pass.** The model provider's free tier was
  exhausted mid-session, so agent steps 403'd. The dispatch path was still
  verified (execution rows created, failures recorded, nothing stranded).

## 15. Data-transformation closing pass (2026-08-06)

The full n8n "Data transformation" palette is now covered, and the ops we
already had were hardened to their n8n node's behavior:

**New `DATA_OPS`** (all pure/sync, dependency-free, in both step editors and
mapped by the n8n importer):

| n8n node | Landed as |
|---|---|
| Date & Time | `formatDate` (YYYY/MM/DD/HH/mm/ss pattern), `dateShift` (add/subtract, month math clamps), `dateDiff` (whole units, calendar-aware months), `datePart` — all UTC for determinism |
| Rename Keys | `renameKeys` — pairs of current → new name, over a record or a list |
| Markdown | `markdownToHtml` / `htmlToMarkdown` — escape-first GFM subset; raw HTML never passes through, script URLs refused |
| XML | `xmlParse` / `xmlBuild` — attributes as `@keys`, text as `#text`, repeats as arrays; round-trips |
| Split Out | `flatten` grew a field setting: each element becomes its own item carrying the record's other fields (importer maps `fieldToSplitOut`) |

**Hardened to n8n behavior:**

- `sort` / `removeDuplicates` / `summarize` group-by accept SEVERAL
  comma-separated fields; `aggregate` with several fields returns
  `{ field: [values] }` per field.
- `summarize` gained `countUnique` / `concat` / `append` aggregations.
- `filterArray` gained `match: any` (OR) alongside the default AND.
- `compose` / `select` dotted field names build nested objects (n8n Set).
- The interpreter now passes `by` / `descending` / `aggregations` through to
  the op runner — previously those settings were silently dropped at run time
  (pinned by an interpreter-level test).

**Deliberately deferred** (binary plane / heavy deps; revisit on demand):
Compression, Edit Image, Convert to File / Extract from File as dedicated
steps (file references + HTTP `responseType: 'file'` + text-op auto-extract
cover the common path), Crypto, and HTML CSS-selector extraction (the AI
extract step covers it in plain English).

---

# Addendum — Import fidelity & credential surface (2026-08-07)

> **Status update (2026-08-07, same day): §17 and §18 closed.**
>
> **§17 import fidelity:** Sheets/Salesforce write payloads now carry mapped
> columns/fields (resource-mapper + legacy shapes, autoMap warns loudly);
> URL-mode locators extract the bare file id; `onError: continueErrorOutput`
> → `onError:'route'` + a labelled `error` edge; `disabled` carries; merge
> combine modes map (byFields→combineByKey+key, byPosition, combineAll;
> SQL/chooseBranch warn); Set carries per-field `type` +
> `includeOtherFields`; retryOnFail/maxTries/waitBetweenTries/
> alwaysOutputData map to retries/retryDelayMs/alwaysOutputData; If/Filter
> case-insensitivity → per-clause `ignoreCase`; n8n `pinData` → graph
> pinData keyed by our node ids; the code shim defines luxon-style
> `$now`/`$today` and hoisted expressions using other n8n globals
> ($env/$vars/$execution/…) warn by name; untranslatable-expression warnings
> are per-distinct-expression (cap 5/node), not once-per-node; Slack
> `thread_ts` and Gmail cc/bcc flow through importer AND delivery tools; an
> n8n credential-type table (slackOAuth2Api → nango:slack, ×36 entries)
> binds even unmapped app nodes to the right integration. The import report
> (Workstream 1) shipped in parallel: `n8nToFlow` returns typed
> `FlowImportNote[]` (code/severity/nodeId), the route persists them whole
> (`Flow.importNotes` + blocking count), and the builder's Import notes
> panel renders them with jump-to-step and Clear.
> Tests: `import/__tests__/import-fidelity.test.ts` (27), delivery tests,
> `import-route.db.test.ts` (typed + anchored assertions).
>
> **§18 credential surface:** `WorkspaceCredentialsPanel` is rendered on
> /integrations (Slack bot token / Resend / Granola now connectable — also
> unblocks the Granola dead end); the step-drawer's predefined-credential
> picker is renamed "Connected server (MCP)" with an honest empty state
> (no more "No connected integrations yet" lie); the OAuth grid carries
> per-provider connect hints (Zendesk subdomain, Salesforce sandbox, Notion
> page-sharing, …) and an amber connected-but-zero-tools note;
> nango-setup.md now lists all 16 providers. Guarded by
> `components/integrations/__tests__/credential-surface.test.ts` (dead-code
> scan — the panel can't silently orphan again).

Prior passes audited engine semantics (§2), editor UX (§3), and node
configuration (§6–§13). This pass audits the two remaining surfaces: **what
survives an n8n import** and **what a user is asked for when connecting an
integration**. Method: fresh n8n source clone as ground truth (403 credential
schemas, serialized-JSON shapes from `packages/workflow/src/interfaces.ts` +
`schemas.ts`), plus a **live probe** — 13 real-shape n8n workflow exports
(resource locators, `assignmentCollection`, FilterValue conditions, resource
mappers, `onError` branches, pinData, disabled flags) pushed through
`n8nToFlow` and the output inspected. Findings below are run-verified, not
read-verified, except where noted.

## 17. Import fidelity — ranked

### P0 — silent data destruction (the "every import uncovers major flaws" class)

1. **Write payloads are emptied, with a misleading warning.** Verified live:
   Google Sheets append with a v4 `columns` resource-mapper
   (`{mappingMode:'defineBelow', value:{Name:…, Email:…}}`) imports as
   `google_sheets_append_row` with `values: []`; Salesforce create with
   top-level fields + `additionalFields` imports as `salesforce_create_record`
   with `fields: {}`. The only warning is "confirm the … connection under
   Integrations" — the flow *looks* correctly bound and then writes nothing.
   Fix: read `columns.value` / the per-resource field params and
   `additionalFields`, translate expressions per value; warn loudly on any
   shape we can't read.
2. **Sheets `documentId` in `url` mode passes the whole URL as
   `spreadsheetId`.** Verified live: `https://docs.google.com/spreadsheets/d/
   1AbCdEfG/edit#gid=0` lands verbatim in args. n8n's `url` RL mode
   regex-extracts the file id; `locatorValue()` (from-n8n.ts:250) returns
   `.value` raw. Runtime call fails. Same risk for any RL whose `url` mode
   needs extraction.
3. **`onError: 'continueErrorOutput'` error branches import as ordinary
   success edges.** Verified live: the "Alert on failure" branch becomes a
   parallel unlabelled edge — it now runs on every *success* and does not run
   on failure. Branch labelling (from-n8n.ts:1816-1824) only covers
   `condition`/`switch`. Our schema has `onError:'route'` + an error edge —
   map it; until then, at minimum warn.
4. **Disabled nodes import live.** Verified live: a `disabled: true` HTTP
   POST imports as an executable step, silently. `disabled` is parsed into
   `N8nNodeIn` (:26) and never read. Our schema has `disabled` — copy it.

### P1 — silent behavior changes

5. **Merge configuration dropped without warning.** Verified live:
   `combine`/`combineByFields` on `email` + `joinMode:'keepMatches'` imports
   as `join mode:'append'` — no warning. Our `join` already supports
   `combineByKey` (§13): map `combineByFields → combineByKey`,
   `fieldsToMatchString → key`, `combineByPosition → combineByPosition`; warn
   on SQL/chooseBranch only.
6. **Set/transform loses `includeOtherFields` and per-field `type`.**
   Verified live: v3.4 assignments import as bare `{name, value}` fields —
   `type:'number'` and `includeOtherFields:true / include:'all'` vanish. Our
   transform supports both (§13). Consequence: imported transform *replaces*
   the payload where n8n *merged*, and typed values become strings.
7. **Node-level reliability settings dropped.** Verified live: `retryOnFail`,
   `maxTries`, `waitBetweenTries`, `alwaysOutputData` all discarded — our
   schema has `retries`, `retryDelayMs`, `alwaysOutputData` (§13). Pure
   mapping work, zero engine change.
8. **Hoisted expressions can reference n8n globals the sandbox never
   defines.** Verified live: `={{ $now.minus(7, 'days') }}` hoists into the
   compute code step verbatim — but `withN8nCodeShim` defines only `$`,
   `$input`, `$json`, `items`. The step throws `ReferenceError: $now is not
   defined` at run time. Shim should define `$now`/`$today` (Date-based),
   and the hoister should warn on `$env`, `$vars`, `$execution`, `$workflow`,
   `$jmespath`, `DateTime` instead of emitting code that cannot run.
9. **If-node case sensitivity dropped.** Verified live: `options.ignoreCase`
   / `caseSensitive:false` vanish; our clauses support per-clause
   `ignoreCase` (§13). (The `or` combinator DOES carry — `match:'any'`.)
10. **`pinData` silently discarded — we have the feature.** n8n pinData is
    exactly our mock-output/pinData system; map per-node entries instead of
    dropping. Ditto `settings.errorWorkflow` → note pointing at our
    `flow.failed` signal flows.
11. **Slack `otherOptions` (thread_ts threading, unfurl, sendAsUser) and
    Gmail `options` (cc/bcc/senderName) silently dropped.** Verified live:
    happy-path args (channel/text, to/subject/body) carry; the rest vanish
    without a note. Threading loss changes behavior invisibly.
12. **Credential references are never read.** The importer uses
    `node.credentials` only as a boolean. The credential-type key
    (`slackOAuth2Api`, `gmailOAuth2`, `googleSheetsOAuth2Api`,
    `salesforceOAuth2Api`, `hubspotOAuth2Api`, `notionApi`, …) is a reliable
    provider signal n8n ground truth gives us for free — a
    credential-name → plane table would bind tools even when the node *type*
    is unmapped (today those become unbound `tool` stubs named
    `"<segment>.<op>"`).

### P2 — visibility

13. **Warning throttling hides breakage**: untranslatable expressions warn at
    most once per node, and only when they contain `(` or `$`
    (from-n8n.ts:1426). Broken tokens ship silently past the first.
14. **The import report (Workstream 1 of the 2026-08-07 flow-gap-closure
    plan) is the meta-fix and is unbuilt.** All warnings die with the import
    toast today. Every finding above should land as a typed
    `FlowImportNote`, several with node-anchored severity=error.

### Verified working — don't re-fix

Resource-locator extraction for `list`/`id`/`name` modes (Slack channel RL →
`C0123ABC`); `$json` parenting and `$('Node')` translation; If `or`
combinator → `match:'any'`; switch fallback → `default` branch edge and
per-case branch labels; schedule `rule.interval` → cadence (imported paused,
warned — by design); HTTP expression hoisting mechanics and stale-warning
splice; the code shim executing in the real QuickJS sandbox; Slack/Gmail/
Salesforce-read happy-path arg mapping; loop-edge suppression; auth
auto-bind for HTTP hosts (`bind-imported-auth.ts`).

## 18. Credential surface — why it feels "random"

Ground truth: n8n ships 403 credential schemas; every provider's quirks are
first-class fields (Zendesk **subdomain**, Salesforce **sandbox/production**
environment, Jira **domain** ×4 variants, GitHub **server** for Enterprise,
Gong **baseUrl** + key/secret, Microsoft tenant-in-URL + national-cloud
picker + certificate-vs-secret, Slack **signature secret** + scope lists,
Linear **actor** + admin-scope toggles). Ours, by plane:

| Plane | Per-provider tailoring |
|---|---|
| Nango OAuth (16 providers) | **None on our side** — identical Connect button; scopes/subdomains live in Nango's dashboard/iframe, invisible to us |
| HTTP credentials | Generic by auth *type* (8 types), host-locked, live-verified — solid but provider-blind |
| MCP connections | Best UX (auto-discovery, test button), single generic form |
| `credential-providers.ts` (slack/email/granola) | **The only tailored registry — and its panel (`WorkspaceCredentialsPanel`) is dead code, never rendered** |
| People.ai OAuth | Single-purpose, fine |

Ranked findings:

1. **`WorkspaceCredentialsPanel` is orphaned** (workspace-credentials-panel.tsx:161,
   zero importers). Slack bot token, Resend key, Granola key have no entry
   point; agents error with "Granola not connected" and no path to connect.
2. **The step-drawer's "Predefined Credential Type" list excludes Nango
   connections and then claims "No connected integrations yet"** — false for
   anyone who connected via the grid (step-drawer.tsx:643-650).
3. **Zero per-provider guidance on the connect grid** — no scope disclosure,
   no "you'll need your Zendesk subdomain", no docs links. n8n's per-provider
   fields are the tailoring users expect; ours arrives unannounced inside
   Nango's iframe.
4. **Slack spans three planes** (native bot token / Nango delivery / Nango
   tools) with one label and three different credentials. Needs one "Slack"
   surface that explains which capability each connection powers.
5. **Four vocabularies for one concept**: "Predefined/Generic Credential
   Type" (n8n-derived) vs "Authentication method" vs "Authentication" vs
   "Connect".
6. **Docs/code drift**: nango-setup.md lists 14 providers, code has 16
   (airtable, figma undocumented → likely unconfigured in Nango → connect
   succeeds with 0 tools and only a soft signal; the doc-promised amber
   mismatch note does not exist in code).
7. HTTP credential auth-type list is unfiltered by target host (offers OAuth1
   and Digest for `api.github.com` with no hint). A small host → suggested-
   auth-type hint table (seedable from n8n's credential schemas) would close
   most of the perceived distance.

## 19. Recommended sequencing

1. **Ride Workstream 1 (import report)** — land the P0 import fixes (§17.1-4)
   *with* the persistent `FlowImportNote` surface, so remaining losses become
   visible instead of silent.
2. **Mapping-only P1 fixes** (§17.5-7, 9-11): merge modes, transform
   include/types, retry/alwaysOutputData, ignoreCase, pinData, Slack/Gmail
   options — all target schema fields that already exist.
3. **Credential-name → plane binding table** (§17.12) + shim `$now/$today`
   (§17.8).
4. **Credential surface**: resurrect or fold `WorkspaceCredentialsPanel` into
   the integrations page; fix the predefined-credential empty-state lie; add
   per-provider connect guidance (subdomain/environment/scopes) seeded from
   the n8n schema ground truth in this addendum.
