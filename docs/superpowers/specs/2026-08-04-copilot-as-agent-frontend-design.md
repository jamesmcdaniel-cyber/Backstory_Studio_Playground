# Copilot as the agent's frontend

**Date:** 2026-08-04
**Status:** Approved, pending implementation plan

## Problem

The assistant panel cannot do the work its agent can do.

Asked "what tools do our clients' competitors mostly mention — look through
transcripts, emails and call history", the panel spins on "Thinking…" and then
either admits it has no data or invents an answer. It has no tools. It cannot
read a transcript.

The agent it is attached to can do all of that. The copilot is a separate,
weaker brain sitting next to the agent rather than a way to talk to it.

## Current state

`POST /api/agents/[id]/chat` makes a single `generateStructured` call
(`src/app/api/agents/[id]/chat/route.ts:220`). One shot, JSON-schema
constrained, grounded only in the static snapshot from `buildAssistantContext`
— agent config, recent run summaries, and the Backstory MCP tool catalogue.
No tool loop, no tool calls, no intermediate events.

The agent runtime, by contrast, already has everything this needs:

| Concern | Where it already exists |
| --- | --- |
| Multi-tool loop | `runAgentExecution` (`src/features/agents/execute-agent.ts:369`) |
| Tool events | `tool.started`, `tool.completed`, `tool.failed`, `tool.queued_for_approval`, `agent.thinking`, `agent.plan` |
| Write approval | `requiresApproval(provider, flag, isWrite)` (`src/lib/agents/approval.ts:29`) |
| Approval resume | `POST /api/executions/[id]/reply` |
| Live timeline UI | `ToolCallCard` + process timeline (`src/app/agents/agent-activity-pane.tsx:177`) |
| Run polling | `GET /api/agents/[id]/runs/[runId]`, polled while a run is active |

The parts exist. They are not connected to chat.

## Decisions

1. **Always tool-enabled.** Every chat turn runs the agent's real tool loop.
   No router. The model calls tools only when the question needs them, so
   "change the schedule to 9am" costs a turn with zero tool calls.
2. **Writes confirm inline.** Read tools run freely; any write tool pauses and
   renders a confirm card in the thread.
3. **A chat turn is a real run, hidden by default.** It creates a normal
   `AgentExecution` so it inherits the whole stack, but is filtered out of the
   runs list behind an "include chat" toggle.

## Architecture

### A chat turn is an AgentExecution

`AgentExecution.trigger` is already `Json`, so chat runs tag as
`{ type: 'chat', sessionId, chatMessageId }` with **no migration**.

Two endpoints, because the client needs the execution id *before* the run
finishes in order to follow it:

- `POST /api/agents/[id]/chat` — creates the session if new, persists the user
  message, creates the `AgentExecution` row as `pending`, returns
  `{ sessionId, userMessage, executionId }` immediately. In queue mode it also
  enqueues, and that is the whole request.
- `POST /api/agents/[id]/chat/run` — inline mode only. Long-lived
  (`maxDuration = 300`), calls `runAgentExecution`, persists the assistant
  message on completion.

Either way the panel polls `GET /api/agents/[id]/runs/[executionId]` — the
endpoint the activity pane already polls. This mirrors the existing manual-run
shape in `src/app/api/agents/[id]/execute/route.ts:36-58` rather than inventing
a new execution path.

Rate limiting matches the manual-run route (`agent-run:<org>`, 30/min).

### Tool exposure

Chat runs receive the agent's full tool set, plus two adjustments:

**Config proposals become a tool.** `propose_agent_config` replaces the
`proposal` field in `RESPONSE_SCHEMA`. It is exposed only on chat-triggered
runs. Its arguments feed the existing `ProposalCard`, so the apply path
(`PUT /api/agents` then `PATCH /api/agents/[id]/chat`) is untouched.

**Write tools force approval.** Chat-triggered runs pass `flag = true` into
`requiresApproval`, so writes emit `tool.queued_for_approval` even when the
agent's own approval flag is off. The existing `/api/executions/[id]/reply`
resume path handles the decision. An agent that already requires approval
behaves identically — this only ever adds a gate, never removes one.

### UI

Extract the timeline out of `agent-activity-pane.tsx` into a shared
`src/components/agents/run-timeline.tsx`: `ToolCallCard`, thinking/plan steps,
and the approval card. Both the activity pane and the assistant panel render
it, so the two surfaces cannot drift.

In chat the live timeline replaces the `Thinking…` block, then collapses to a
summary (`4 tools · 12s`) once the answer lands. Reopening an old session shows
the collapsed summary, because `executionId` is stored on the assistant
message's metadata.

### Runs list

The runs list filters `trigger.type = 'chat'` out by default, with an "include
chat" toggle. Chat runs remain fully queryable and observable.

### What is removed

The one-shot `generateStructured` call and its proposal schema.
`buildAssistantContext` survives as the run's seed context rather than its only
grounding.

## Rollout: EXECUTION_MODE — done 2026-08-04

Production ran `EXECUTION_MODE=inline` on Vercel, bounded by the ~5 minute
serverless ceiling. A wide fan-out across transcripts, email and Salesforce can
exceed that, so `queue` is a prerequisite for this feature to be reliable, not
merely a nice-to-have.

Flipped after confirming `backstory-worker` on Render was green and consuming
on the same Upstash Redis that Vercel enqueues to. Order matters, per
`render.yaml`:

> Rollout order: deploy this worker → confirm its logs show both queues
> consuming → THEN flip Vercel's `EXECUTION_MODE` to `queue`. Flipping first
> leaves runs stuck in `pending` with nothing draining them.

Final state:

| Target | Value | Why |
| --- | --- | --- |
| Production | `queue` | Runs execute on the worker, no serverless ceiling |
| Preview | `inline` | **Must be set explicitly — see below** |

**Preview must never be left unset.** `resolveExecutionMode()` falls back to
`NODE_ENV === 'production' ? 'queue' : 'inline'`, and Vercel Preview builds also
run with `NODE_ENV=production`. An unset Preview therefore resolves to `queue`,
so preview deployments would enqueue onto the shared Upstash Redis and the
production worker would execute those jobs against the **production database**.
The single env record originally covered Production and Preview together, so
removing it silently exposed this; both targets are now set explicitly.

Rollback is setting Production back to `inline` plus a redeploy.

Remaining verification: trigger one agent run in production and confirm it
leaves `pending` — the only end-to-end proof the worker is draining Vercel's
queue rather than a different one.

## Testing

- Chat turns tag `trigger.type = 'chat'` and carry `sessionId`.
- A write tool on a chat run queues for approval even when the agent's approval
  flag is off; a read tool does not.
- `propose_agent_config` arguments produce the same proposal shape the apply
  path already consumes.
- The runs list excludes chat runs by default and includes them when toggled.
- The shared timeline renders tool cards in the chat thread and collapses on
  completion.
- The existing suite (1629 passing) stays green.

## Risks

- **Latency and cost rise on every message.** A config-only ask becomes a real
  agent turn (~3–8s) rather than one structured call, and per-message token
  spend rises materially. Accepted: it is the cost of the copilot never being
  less capable than its agent.
- **The queue flip can wedge production** if the worker is not draining. Gated
  on the check above.
- **Approval fatigue.** Forcing confirmation on every write may annoy users who
  deliberately turned approvals off. Revisit only with real usage; the safe
  default is cheaper to loosen than a bad send is to undo.

## Out of scope

- The flows copilot (`src/components/flows/copilot-panel.tsx`) — it edits flow
  graphs, a different job.
- Real SSE streaming. Polling already works and keeps both surfaces on one
  mechanism.
