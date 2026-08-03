# Run Observability & Platform Access — Design

**Date:** 2026-08-03
**Status:** Approved, ready for implementation planning

Four workstreams landing in one spec. Three concern the run lifecycle (cost, eval,
fork); the fourth is platform access control, added mid-design. They are
independent and can ship in any order — the suggested sequence is in §5.

---

## Context

This work replaces the reflex to adopt LangGraph/LangSmith. Both were assessed
and rejected: every LangGraph primitive (durable checkpointing, DAG scheduling,
human-in-the-loop interrupts, streaming, cyclic model-driven control flow) already
exists in this codebase, and `docs/flows-n8n-parity-audit.md:150` already put
LangChain-style wiring on the explicit do-not-build list. LangSmith's trace tree,
fixtures, and transcript-to-fixture flywheel are likewise already present in
`src/lib/eval/`. What is genuinely missing is narrower than a framework: cost
accounting, automated quality gating, per-fork state editing, and runtime-editable
domain access.

Additional constraint: LangSmith ingests prompts and responses into a third-party
SaaS. Given the People.ai delivery surface, that is a data-residency conversation
this design avoids entirely.

---

## §1 — Cost ledger

**Purpose:** internal ops visibility. Not invoicing, not chargeback, not dollar-
denominated budget enforcement. Best-effort accuracy is acceptable; provider
invoice reconciliation is out of scope.

### Prerequisite fix (blocking, and a live correctness bug)

`src/lib/llm/model-runner.ts:146-152` currently collapses three billing-distinct
token buckets into one field:

```ts
inputTokens:
  message.usage.input_tokens +
  (message.usage.cache_creation_input_tokens || 0) +
  (message.usage.cache_read_input_tokens || 0),
```

Cache reads bill at roughly 0.1x and cache writes at roughly 1.25x. Because the
runner applies a rolling prompt cache (`withRollingCache`, same file), a
cache-heavy run's stored token count cannot be converted to dollars without
overstating cost by close to an order of magnitude. **No ledger is possible until
this is fixed.**

Changes to `ModelTurn`:

- `usage` becomes four fields: `inputTokens`, `cacheWriteTokens`,
  `cacheReadTokens`, `outputTokens`.
- Add `provider` and `servedModel`, set inside `AnthropicProvider.next()`.
  `AgentRunner.next()` falls back across providers mid-turn
  (`model-runner.ts:196-213`), so the requested model is not reliably the model
  that served the turn. Attribution must use the actual one.
- Expose a `billableTokens` accessor summing input + output, so existing callers
  (`execute-agent.ts:934`, `recordTokenUsage`) keep their current behavior with no
  edit.

### Capture points

Four, all existing chokepoints. Nothing else in the codebase calls a model.

| Surface | Location | Currently metered |
|---|---|---|
| `agent_turn` | `AnthropicProvider.next` | Yes, incorrectly (see above) |
| `structured` | `anthropicWireStructured` (backs all `generateStructured` — copilot, agent builder, assistant chat) | No |
| `headline` | `generateHeadline` | No |
| `embedding` | Voyage fetch, `src/lib/rag/embeddings.ts:107` | No |

`eval_judge` is a fifth surface value, applied when `judgeTrajectory` drives a
`structured` call (see §2).

### Schema

New `LlmCall`:

- `id`, `organizationId`
- nullable `agentExecutionId`, `flowRunId`, `flowRunStepId`
- `surface` — `agent_turn` | `structured` | `headline` | `embedding` | `eval_judge`
- `provider`, `model`
- `inputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `outputTokens`
- `costUsd` — `Decimal(12,6)`
- `priceVersion`, `createdAt`
- Indexes: `[organizationId, createdAt]`, `[flowRunId]`

Denormalized `costUsd` totals on `AgentExecution` and `FlowRun`, so list views do
not aggregate on every read.

The nullable foreign keys matter: `generateStructured` calls from copilot and the
agent builder have no `AgentExecution` row at all, so an aggregates-only design
could not capture them.

### Pricing

A versioned constant table at `src/lib/usage/pricing.ts`, keyed by
provider + model, carrying all four rates. Cost is computed and **snapshotted at
write time**; a later price change never rewrites history. `priceVersion` records
which table produced the row.

Unknown model → `costUsd` `0`, `priceVersion` `'unknown'`, plus a warn log. A newly
released model must never break a run.

### Consistency and failure

Rollup increments happen inside the same transaction as the existing token
increments (`execute-agent.ts:568` and the flow equivalents), so rollups cannot
drift from detail rows under concurrent workers.

The `LlmCall` insert is outside that transaction and best-effort — the same posture
as `recordTokenUsage`. A dropped row under-reports. A run failing because billing
telemetry hiccuped is unacceptable.

### Retention

A sweep in the existing retention cron drops `LlmCall` rows older than 90 days.
Denormalized totals survive, so historical run costs stay visible after detail
ages out.

### Surface

Admin-only, under the existing `/admin`. Not exposed to customer org admins.

---

## §2 — Eval gate

### Correction to the original premise

`npm test` runs `find src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \)
-path '*__tests__*'`, which already matches `src/lib/eval/__tests__/eval.test.ts`.
**Deterministic scripted-replay evals already gate every PR.** `npm run eval` is a
narrower subset of the same tests. What is ungated is the judge-based and RAG
evals, not evals as a whole.

### PR gate: no new workflow

Deterministic replay already runs in CI. `checkTrajectory` returns pass/fail
assertions, which is the correct shape for a merge gate, and the judge path
already self-skips without a model key (`judge.ts:7-8`). Work here is corpus
growth, not plumbing.

### Nightly quality gate

New `.github/workflows/eval-nightly.yml`, cron-scheduled, with `ANTHROPIC_API_KEY`
and `VOYAGE_API_KEY` secrets plus the pgvector service the existing `check` job
already defines. Runs live fixtures through `runLoop` + `judgeTrajectory`, then
`eval:rag`.

### Handling judge nondeterminism

`JudgeResult.score` is a 0..1 float produced by an LLM; a single sample is too
noisy to gate on.

- Each fixture is judged **3 times and averaged**.
- `src/lib/eval/baseline.json` (committed) holds per-fixture mean scores.
- Nightly fails when a fixture drops more than **0.15** below its baseline, or
  when the corpus mean falls below an absolute floor of **0.7**.
- Both thresholds are tunable constants.
- The first nightly run **writes** the baseline rather than failing against an
  empty one.

### Alerting

On failure the workflow opens or updates a single GitHub issue containing the
scorecard diff. No Slack webhook, no new service.

### The flywheel

New `npm run eval:capture -- <executionId>`: reads that `AgentExecution`'s
`transcript`, pipes it through the existing `fixtureFromTranscript`
(`src/lib/eval/from-transcript.ts`), and writes a fixture file under
`src/lib/eval/fixtures/`. The operator adds a rubric and commits. This is the
piece that converts a production failure into a permanent regression test; it is
small because `from-transcript.ts` already does the parsing.

### Tie to §1

Judge calls record to the ledger with `surface: 'eval_judge'`, making nightly eval
spend visible rather than mysterious.

---

## §3 — Fork & state overrides

### What already exists

Run forking is shipped. `replayFrom: { runId, nodeId }` replays every step before
the cutoff and executes fresh from there (`execute-flow.ts:503-520`), the execute
route accepts it (`execute/route.ts:117`), and there is a "Re-run from here"
control (`run-panel.tsx:229`). It handles error-edge re-taking and per-iteration
`node#i` rows.

`pinData` (`execute-flow.ts:525`) already provides value override with n8n pin
semantics. The gap is that `pinData` lives on the **flow graph draft**
(`graph.ts:689`), so overriding state to test a fork mutates the shared flow.

### Mechanism

New nullable column `FlowRun.stateOverrides Json?` — a map of node id (or `node#i`
iteration key) to the value that node should yield.

Key resolution: an exact `node#i` entry applies to that iteration only; a bare
`node` entry applies to every iteration of that node. When both are present the
more specific `node#i` wins.

Applied in `runFlowExecution` immediately after the existing pin block, giving
precedence:

```
stateOverrides > pinData > replayed output
```

`graphSnapshot` is never mutated. This was chosen over injecting into
`graphSnapshot.pinData` (which would violate the immutability invariant the
execution-hardening work established) and over writing the patched value onto the
`FlowRunStep` row (which destroys the original output — the very evidence a
debugging fork exists to inspect).

### Two modes

| Mode | Job shape | Target | External side effects |
|---|---|---|---|
| Fork | `replayFrom: { runId, nodeId }` + `overrides` | New `FlowRun` row; source untouched | **Re-fire** |
| Patch-resume | `flowRunId` + `resumeFrom: { nodeId }` + `overrides` | Same run row, reopened | Deduped |

The asymmetry is real and load-bearing: `flowSideEffectKey` hashes `flowRunId`
(`idempotency.ts:6-9`), so a fork gets fresh idempotency keys and will re-send
that email, while a patch-resume reuses the run id and stays deduped. **The UI
states this per mode at the point of action** — it is the difference between a
safe retry and a duplicate invoice.

### Patch-resume constraints

Restricted to `failed` runs only.

- Not `succeeded` — rewriting a completed run's history has no recovery
  justification and corrupts the record.
- Not `running` / `waiting` — the existing resume path
  (`resume/route.ts:30`) already owns those.

### Append-only reopening

Rather than deleting rows at or after the cutoff, re-execution appends new
`FlowRunStep` rows continuing from the current max `order`. Seeding reads, per
node id, the latest row with `order < cutoff`; rows at or after it are treated as
superseded.

Consequences: the original failed row survives as evidence, and a second
patch-resume composes with no special handling.

### Manifest, permissions, audit

A fork pins the source snapshot via the existing `resolveValidatedGraph`. A
patch-resume carries the run's own `graphSnapshot` and `executionManifest`, so the
existing drift check refuses a stale patch with no new logic.

Overrides require flow edit permission and write an `AuditEvent` — injecting
arbitrary data into a run must be attributable.

### UI

The existing "Re-run from here" control gains a sibling "Fork with edits…" that
opens the step's recorded output as editable JSON, with a mode toggle
(patch-in-place enabled only for failed runs) and the side-effect warning.

---

## §4 — Platform domain allowlist

### Current state

`src/lib/auth/company-domain.ts` hardcodes the gate:

```ts
export const COMPANY_EMAIL_DOMAINS = ['people.ai', 'backstory.ai'] as const
```

checked in `src/app/auth/callback/route.ts:27-33` after the provider returns a
verified email and before the session is admitted. Adding a customer today
requires a code change and a deploy.

### Placement decision

This is **not** an org-settings feature. `/settings` is org-scoped, so any
customer admin could add their own domains and self-grant platform access,
inverting the boundary. It lives at `/admin`, gated on `platformRole: 'reviewer'`
— the role `applyStaffBootstrap` (`src/lib/supabase/auth-utils.ts`) already
manages.

### Why not reuse `OrganizationDomain`

`OrganizationDomain` maps domain → org with DNS TXT verification, answering "does
this domain belong to workspace X" for SSO enforcement. Overloading it with "may
this domain reach the platform at all" would mean a customer verifying a domain
implicitly grants themselves access. Separate table.

### Schema

New `PlatformAllowedDomain`:

- `id`
- `domain` — unique, lowercased
- `organizationId` — the shared workspace domain members join
- `note`
- `addedByUserId`
- `createdAt`, `disabledAt`

### Gate

`isCompanyEmail` becomes `isAllowedEmail(email)`, called from the same point in the
callback. It passes if the domain is in the hardcoded `COMPANY_EMAIL_DOMAINS`
**or** has an active `PlatformAllowedDomain` row.

This runs only at sign-in, not per request, so a direct query is sufficient — no
cache, therefore no invalidation bug.

`COMPANY_EMAIL_DOMAINS` remains hardcoded and un-removable via the UI: the floor
that guarantees you cannot lock yourself out of your own platform by editing a
table.

### Input safety

Two rules, both load-bearing:

1. **Exact match only.** Preserves the existing lookalike defense
   (`people.ai.attacker.tld`). Wildcards rejected.
2. **Public-provider blocklist.** `gmail.com`, `outlook.com`, `yahoo.com`, and
   similar are rejected outright. One fat-fingered entry there silently opens the
   platform to anyone with an email address — the highest-consequence failure mode
   in this feature.

### Provisioning

`provisionUser` gains one branch: if the email's domain matches an active
allowed-domain row, join that row's organization as a member instead of creating a
fresh workspace. Everything downstream — RLS, org scoping, entitlements — works
unchanged, because the user simply has a different `organizationId`.

### Revocation

Explicit, never implicit. Disabling a domain blocks new sign-ins immediately;
existing sessions survive until expiry. The disable action asks whether to also
deactivate that domain's users now. Silently killing sessions surprises; silently
leaving access open is a hole. The operator chooses.

Every mutation writes an `AuditEvent`.

---

## §5 — Cross-cutting

### Migrations

Three, following the existing dated-directory convention:

1. `LlmCall` table + `costUsd` rollup columns on `AgentExecution` / `FlowRun`
2. `FlowRun.stateOverrides`
3. `PlatformAllowedDomain`

No backfill. Historical runs have no per-call data, so the ledger starts at
deploy; rollup columns default to `0`. `AgentExecution.inputTokens` is left
untouched so nothing currently reading it changes behavior.

Per the baselined `prisma migrate deploy` setup, the existing CI `migrations` job
(history applies from zero, no schema drift) covers all three.

### Testing

Pure-function tests:

- Pricing math — four buckets → dollars; unknown model → `0`
- Baseline comparison — scorecard + baseline → pass/fail
- `isAllowedEmail` — lookalike rejection, public-provider blocklist
- `fixtureFromTranscript` capture transform

DB-backed tests (real assertions in CI, self-skipping locally without
`TEST_DATABASE_URL`, matching the existing pattern):

- Override precedence: `override > pin > replay`
- Patch-resume rejects non-`failed` runs
- Append-only ordering across two generations
- Idempotency keys differ on fork, match on patch-resume
- Domain-matched provisioning joins the shared org

### Build order

1. **Domain allowlist** — independent, and the only item currently blocking
   customers from reaching the platform at all
2. **Four-bucket `ModelTurn` refactor** — pure, no schema
3. **Cost ledger** — schema, capture, admin view
4. **Fork & overrides**
5. **Nightly eval** — last, since it depends on the ledger for `eval_judge` spend
   visibility

### Out of scope

- Invoice reconciliation and chargeback
- Dollar-denominated budget enforcement — the token ceiling in
  `src/lib/usage/budget.ts` stays as-is
- Per-domain provisioning modes (shared-org is the single behavior)
- Prompt-diff forking and side-by-side output comparison
- Exposing cost to customer org admins
