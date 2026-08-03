# Flows ↔ n8n Parity Audit

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
