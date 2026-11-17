# Sync-gap audit — agents and flows (2026-11-17)

**Trigger.** James asked for "a deeper audit on the studio platform (specifically the agents and flows) to close any remaining sync gaps", after three bugs that day had the same shape. In each, two halves of the platform disagreed about one fact:
- **Connect, then refused.** The Integrations page offered members **Connect**, but the session route was admin-only.
- **Connected, but unused.** Snowflake and Databricks connected through Nango, while their tools read host-bound credentials.
- **Filters that changed nothing.** The ROI filters reached the report, but the first screen never moved.

**Definition.** A *sync gap* is two representations of one fact that can disagree, leaving a user at a dead end or with wrong behaviour.

**Method.**
- **Audit.** Four read-only auditors, one per dimension. Each had to cite both sides of every gap.
- **Fixes.** Five implementers, each in an isolated worktree, grouped by file area. No migrations.
- **Merging.** Merged one at a time. Each merge was gated with typecheck, lint, the full CI-mode suite including DB tests, and the build validated on Vercel.

## Decisions taken with James
- **Shared flows with a personal HTTP credential** run with the **runner's own** credential.
  - Scheduled, webhook, poll and event runs act as the flow owner.
  - A teammate's manual run needs their own credential, or a per-user resolver. The run refuses with a message naming the fix.
- **Warehouse (Snowflake/Databricks) agent tools** keep the admin-login fallback. The person's own login is always preferred.

## Findings and dispositions

### G1 — owner attribution, quarantine, what fires (20212ece)
1. **Quarantined agents fired from webhooks and signals as the org's oldest member.**
   - One attribution rule now applies everywhere: `resolveRunOwner` in `scheduling/owners.ts`.
   - The runtime refuses quarantined agents with `AGENT_QUARANTINED`.
2. **Bulk domain deactivation skipped revocation and quarantine.**
   - It now calls `deprovisionUser` for each matched user.
   - The registrar no longer falls back from an inactive named owner.
3. **Published agents fired with the draft schedule and objective.** `runSchedule` and `runObjective` now feed the registrar, the tick, the webhook and signals.
4. **Timer waits of deprovisioned owners starved the wait-resume queue.** `failOwnerlessWaits` fails them with a reason.
5. **Event-triggered flows used per-path owner rules and ignored quarantine.**
   - The webhook, forms, signals, activity and resume paths now use the shared rule and filter quarantine.
6. **An external agent's reply key died with its registrant.** The key's state is now visible, a dead key fails runs before sending, and the admin re-issues it.
7. **Demo clones copied armed schedules.** Clones are disarmed, and the registrar and tick exclude demo orgs.
8. **Schedulers of hard-deleted agents were orphaned.** The registrar now removes them.

### G2 — flow trigger columns vs the published flow (a75219e9)
1. **Draft autosaves re-armed or disarmed the live trigger.**
   - The trigger and activity columns now hold the **published** trigger while a flow is published.
   - All writers go through `lib/flows/trigger-columns.ts`.
   - The builder shows when the draft trigger differs from the live one.
2. **Revert and version restore didn't re-sync the trigger.** They now do.
3. **The public API PUT wiped the webhook secret and skipped schedule anchoring.**
   - It now uses the shared helper.
   - Concurrent edits return 409.
4. **Changing a poll trigger never reset its cursor, so every record started a run.** The cursor resets whenever the poll identity changes.
5. **Poll triggers could pick write, approval-gated or argument-requiring tools.**
   - The picker now offers only runnable tools.
   - Validation runs at publish.
   - Poll failures are recorded and shown in the builder.

### G3 — run state, approvals, live UI (5bcf5b4a)
1. **A flow couldn't resume after its own agent step**, because the manifest pinned `AgentTask.updatedAt`.
   - The manifest now pins a config revision.
   - Drift on resume is terminal and visible.
   - Rollback restores `resumeAt`.
2. **A failed approved write stranded its run, and the reaper used the wrong status literal.**
   - The run now resumes with a `failed` decision.
   - The literal is now `waiting_for_approval`.
3. **Approvals outlived their run.**
   - Every terminal path supersedes pending approvals.
   - `decideApproval` refuses ended runs with `APPROVAL_RUN_ENDED`.
4. **The approvals inbox ignored private agent and flow visibility.** It now uses `lib/approvals/visibility.ts`.
5. **A parent flow was never woken by its subflow.**
   - `wakeSubflowParent` now wakes it.
   - The parent carries the child's real wait kind.
6. **An agent step read "succeeded" when its agent run was blocked.** It is now a failed step, and degraded runs become step warnings.
7. **Reapers and dead-letter skipped side effects.** Shared run-terminal-effects hooks now cover Slack threads, notifications, `flow.failed`, the error workflow and ROI.
8. **Queued (`pending`) agent runs were invisible and couldn't be cancelled.** They now show in a Queued group and can be cancelled.
9. **Flows had no Stop control.**
   - The Runs panel now has a Stop button.
   - `cancelling` resolves.
   - The builder treats `cancelled` as terminal.
10. **The agent reply box swallowed errors and cleared the draft.** It now shows the server's message and keeps the draft.
11. **Cancelling a flow-owned agent run stranded its flow.** It now stops the flow run as well, or refuses with `FLOW_OWNED_RUN`.

Known open (narrow, no backstop): a child that finishes between its parent's resume claim and the parent's re-pause doesn't wake the parent.

### G4 — UI affordance vs server authorization (1dd72a75, 60dceb56)
1. **VIEWER members got an editable builder.**
   - Their autosaves 403'd silently.
   - A viewer could win the jam persister election and stop everyone's saves.

   Fix:
   - `canEdit` is now computed on the server as `role === 'edit' && flow.write`.
   - Autosave shows a 403 once and drops to view-only.
   - Agent New, Configure, Save, Run and Reply follow `agent.write` / `agent.run` (`lib/agents/viewer-gates.ts`, `lib/flows/viewer-gates.ts`).
2. **A non-owner could set "Only me", locking themselves and the team out.**
   - Visibility changes are owner-only on the server: `FLOW_OWNER_REQUIRED` / `AGENT_OWNER_REQUIRED`.
   - The UI shows sharing options only to the owner.
3. **Template-copy copilots were listed but every action 404'd.** Their cards now open the artifact, and Configure and Run are hidden.
4. **View-only and guest flows offered actions the server refuses**: Publish, Unpublish, Revert, Save, Delete and Restore. These are now gated on `canEdit && !external` in the editor and the list menu, and the server's message is surfaced.
5. **The agent credentials panel offered Test and Remove on rows the caller can't manage.**
   - It now uses `row.canManage`.
   - Remove is relabelled "Delete credential (all agents & flows)", with a confirm.
6. **The step drawer offered Make per-user and Re-verify to every member.**
   - Make per-user is now admin-only (`canCreate` from the resolvers route).
   - Re-verify is owner-only.
   - A credential the viewer can't see now says it belongs to someone else, instead of showing "Verified".
7. **External-agent admin actions were shown to every member.** They are now gated on `api.manage`.

The flow Stop button follows `flow.run`, the same as Run.

### G5 — builder/catalog promise vs runtime (810b5fa6…6c9cb600)
1. **A Nango tool granted to an agent step or artifact assistant loaded nothing.**
   - `stepGrantSelection` now maps each grant to exactly its plane.
   - Granting `nango:slack` no longer loads the workspace bot.
2. **"Read-only" was enforced by tool name only.** It now also drops tools by `binding.isWrite` and by an MCP server reporting the tool as a write. Per-call SQL writes are refused at execution.
3. **Runner-own HTTP credentials** (James's decision):
   - The flow runtime and run validation now refuse another member's personal credential with `HTTP_CREDENTIAL_NOT_OWNED`. The error message names the fix.
   - Agent `credentialForHost` uses the runner's own credential, then an unowned one, never another member's.
   - The ROI host lookups (`roi/load-extract.ts`, `roi/databricks.ts`) are unchanged, as warehouse/ROI paths.
4. **`retryDelayMs` and `alwaysOutputData` never reached the runtime.**
   - Tool and http steps now receive them.
   - Agent steps honour both.
   - Knowledge steps no longer offer run-behaviour options.
5. **Templates asked to "Connect backstory" or a warehouse that was already connected.** `missingIntegrations` now uses `listReachableIntegrationKeys`.
6. **The checker rejected `{{step.<Label>}}` tokens the runtime resolves.** It now accepts them, and `ROUTE_NO_ERROR_PATH` covers ai and subflow steps.

## Operator follow-ups (James)
- **Redeploy the Fly worker** with `fly deploy -c fly.worker.toml`. The registrar, dispatch tick, poller, executor, flow engine, reapers and dead-letter handlers all changed. Until the redeploy, BullMQ schedulers carry old job data (draft objectives, owner fallback).
- **Published flows** whose trigger column was last written by a draft autosave before this fix keep that trigger until their next publish or revert, both of which re-sync it. There was no backfill.
- **Behaviour changes:**
  - A published agent fires on its published cadence. Switching the schedule off still stops it immediately.
  - A republished poll baselines on its first check.
  - The public API flow PUT can return 409.
  - A teammate's manual run of a flow that uses someone else's personal credential is refused with a fix-it message.

## Verification
- **Full CI-mode suite on a fresh database**, with all five groups merged and typecheck and lint clean: 5,512 tests, 5,504 passed, 7 skipped, 1 failed.
- **The one failure** was `external-agents.db.test.ts` › "a run whose agent never answers fails at its deadline". This is a **pre-existing timing flake**, not a regression from these merges. It also fails about 1 run in 12 on `de8a31db`, from before the audit. It is an 8-second `waitFor` on the deadline settle, and it passes in isolation.
