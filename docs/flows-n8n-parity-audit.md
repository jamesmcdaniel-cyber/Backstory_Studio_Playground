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
