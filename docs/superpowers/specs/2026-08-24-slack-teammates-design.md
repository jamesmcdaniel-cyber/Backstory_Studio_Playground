# Slack Teammates — agents summonable by @mention — Design

Date: 2026-08-24
Status: approved for autonomous execution (continuous-execution workflow)
Origin: monday.com AI-first gap analysis, gap 1 of 4 (build order 3 → 1 → 5 → 6). Gap 3 shipped 2026-08-24.

## Goal

A person mentions a teammate in Slack and it does the work there — answering in
thread, under that teammate's own name and face, with the tool access of the
person who asked.

Today Slack is a *trigger source*, not a place a teammate lives. `/api/slack/events`
receives signed deliveries and normalizes them to `message.posted` / `generic`;
`dispatchActivityEvent` fans those out to **flows**. There is no `app_mention`
handling, no agent dispatch, no threaded reply, and no way to address one agent out
of a roster. So agents remain reachable only by going to Backstory — the "AI chat
running parallel to the work" shape the gap analysis identified, just with a nicer
chat.

## Constraint that shapes the design

Slack gives one app exactly one bot user, and a workspace has many agents. Identity
therefore splits in two, and conflating them is the trap:

- **The reply** is the *app speaking as itself* — a Slack app answering in its own
  voice, wearing the teammate's name and avatar. The org bot token is correct for
  this. It is not impersonation and not a shared-credential violation.
- **The tool plane** — reads and writes against CRM, email, Slack itself — is where
  `agents-act-as-user` binds. It must run as the human who asked, because that is
  what decides data visibility, entitlement, run allowance, and permissions.

`resolveDeliveryConnection` already implements the ladder for the second half
(`scope: 'user' | 'org'`, acting user's own connection first). What is missing is
knowing *which human* a Slack mention came from.

## Architecture (five layers)

### 1. Ingestion → `agent.mentioned`

`normalizeSlackEvent` gains an `app_mention` branch producing a new `ActivityKind`,
`agent.mentioned`, added to `ACTIVITY_KINDS`.

**`sourceEventId` is namespaced `slack:mention:{channel}:{ts}`**, distinct from the
existing `slack:msg:{channel}:{ts}`.

This is load-bearing, not cosmetic. Slack delivers **both** `message.channels` and
`app_mention` for the same message when both are subscribed. Same channel, same
`ts` — so under the existing `@@unique([organizationId, source, sourceEventId])` the
second arrival collides with the first and is treated as a redelivery. Whichever
lands first wins, and the mention is silently swallowed. Separate namespaces let both
rows exist, which is correct: they are two different facts about one message.

`selfOrigin` and `chainDepth` carry through unchanged and matter more here than
anywhere else — an agent's reply lands back in the same channel, and
`ACTIVITY_CHAIN_DEPTH_CAP` is what stops it answering itself indefinitely.

### 2. Identity → `SlackIdentity`, fail closed

New model, unique on `[organizationId, slackUserId]`:
`organizationId`, `slackUserId`, `userId`, `verifiedAt`.

Written when a person connects **their own** Slack, from `auth.test` against *their*
token — never from the bot token, which knows only the app.

A dedicated model rather than `NangoConnection.metadata`: this is read on every
mention. `findSlackWorkspaceByTeamId` documents that its JSON-blob table scan was
acceptable precisely *because* it is not a hot path; this one is, and gets a real
unique index.

**No row means no run.** The reply is an in-thread prompt to link Slack. Nothing
executes, no model tokens are spent, no run allowance is consumed. Fail-closed is the
whole point: guessing an identity would spend someone else's budget and expose
someone else's data to whoever can see the channel.

### 3. Addressing → `SlackChannelBinding` + name override

New model, unique on `[organizationId, channelId]`: `organizationId`, `channelId`,
`agentTaskId`.

Resolution order, first hit wins:

1. **Explicit name** — the leading tokens after the mention, matched against the
   roster via the existing `buildRoster` (name, then `roleLabel`, then a
   confidence-gated fuzzy match).
2. **Channel default** — the binding for this channel.
3. **Ask** — reply listing the roster. No run.

A name that matches nothing is an *ask*, never a silent fallback to the channel
default: running a different teammate than the one someone named is worse than asking.

### 4. Dispatch → its own path, not `dispatchActivityEvent`

`dispatchActivityEvent` is flow-only and attributes runs to `flow.userId` or the
oldest active user in the org. That attribution is defensible for a flow trigger its
owner configured; it is exactly the hole this design rejects for mentions. Mentions
therefore get their own handler on the same `activity.dispatch` outbox consumer,
selected on `kind === 'agent.mentioned'`.

Exactly-once reuses machinery that already exists for this purpose rather than adding
a third claim table: `AgentExecution.idempotencyKey`, unique on
`[organizationId, idempotencyKey]` and already documented as the replay guard for
signal-triggered runs. Mentions use **`mention:{activityEventId}:{agentTaskId}`**. A
redelivered mention collides and is a no-op.

The row is created first, then handed to `dispatchAgentExecution` with its
`executionId` (whose `jobId = executionId` makes the enqueue itself idempotent) —
the same prepared-run pattern `startFlowExecution` uses.

`skipApprovalGate` is **not** set. Flow-invoked runs bypass the approval gate because
a flow runs end to end; a Slack mention is interactive and must stop for approval like
any other interactive run.

`trigger` is `{ type: 'slack_mention', channelId, threadTs, slackUserId, activityEventId }`.

**This trigger type breaks the adoption metrics shipped hours earlier, and the fix
belongs in this workstream.** `automationRatio` counts every trigger `!== 'manual'`
as automated. A human @mentioning an agent is the most human-initiated act in the
product, so left alone it would inflate the automation ratio and make the AI-dust
detector wrong in the flattering direction. `slack_mention` must count as
human-initiated in **both** `automationRatio` and `engagedUsers` (whose whole purpose
is counting humans who actually engaged an agent).

### 5. Reply and thread continuity

`AgentChatSession` gains nullable `slackChannelId` + `slackThreadTs`, unique together.
A follow-up in the same thread continues the same conversation instead of starting a
new one.

In queue mode `dispatchAgentExecution` returns before the run finishes, so **the run's
completion path posts the reply**, not the dispatcher. `trigger` is already persisted
on `AgentExecution`, so the finalizer reads the Slack context from there and calls a
single small module, `src/lib/slack/reply.ts`.

Because a multi-turn run takes long enough to look broken, the mention handler posts
an immediate in-thread placeholder as the teammate and stores its `ts`; the finalizer
`chat.update`s that same message with the result. A failed run updates the same
message with a failure line rather than leaving silence. `chat.update` needs no scope
beyond `chat:write`, which is why this is preferred over an acknowledging reaction
(`reactions:write`).

Replies post with the teammate's `name` and avatar via `chat:write.customize`, which
is what makes a roster of teammates distinguishable in Slack rather than one
undifferentiated bot.

## Decisions (recorded rulings)

1. **The reply uses the org bot token; the tool plane uses the asking human's
   credentials.** These are different identities and the design keeps them apart.
2. **Unlinked Slack users cannot summon agents.** Fail closed, with a link prompt.
3. **A named teammate that matches nothing asks rather than falls back.**
4. **`slack_mention` counts as human-initiated** in the adoption metrics.
5. **Approvals still fire** for Slack-initiated runs — `skipApprovalGate` stays unset.
   In this workstream the approval posts an in-thread link to `/approvals`; buttons
   are the follow-on (see Out of scope).
6. **BYO apps and the Backstory-owned app coexist — but this needs one deliberate
   change, not zero.** `resolveSigningSecretForOrg` prefers a workspace's own signing
   secret and otherwise falls back to `SLACK_SIGNING_SECRET`, which is the right
   shape. However that fallback runs through `envFallbackAllowed`, which denies
   **customer** orgs by design, so a customer workspace that installed the
   Backstory-owned app would have its deliveries fail verification.

   That policy exists for a real reason, but it currently conflates two different
   secrets:

   - A shared **bot token** is a shared *identity*. Letting a customer workspace
     reach it means its agents act as, and read what belongs to, every other
     workspace on that account. This is what `org-credential.test.ts` protects, and
     it stays denied — every install gets its own `xoxb-` token.
   - A shared **signing secret** is the app's *signature verifier*. It proves "Slack
     sent this, from this app" and grants access to nothing. Every workspace
     installing the same app is supposed to share it; that is how a distributable
     Slack app works.

   So the signing-secret path — and only that path — allows the env fallback
   regardless of org kind. The bot-token path is untouched. This is a narrowing of a
   guard that was written before a distributable app existed, and it gets its own
   test pinning that the bot token remains denied to customer orgs.

## Slack app configuration

Bot scopes: `app_mentions:read`, `chat:write`, `chat:write.customize`. Event
subscription: `app_mention`. These are additions to the existing list in
`docs/runbooks/activity-plane.md` §5, which this workstream updates.

## Out of scope (this workstream)

- **Slack interactive approvals (gap 1b).** Block Kit Approve/Reject buttons need a
  second signed endpoint (`/api/slack/interactions`), its own signature verification,
  and an authorization check that the person pressing the button may decide this
  approval. That last item is a real authorization surface and gets its own spec
  immediately after this one.
- **The OAuth install flow for the Backstory-owned distributable app.** The receiver
  already supports it (see ruling 6); what is missing is the install route that writes
  the credential row instead of a human pasting a token. Separable, and this
  workstream does not block on it — the app can be installed into one workspace and
  its token saved through the existing `/credentials` path.
- **DMs to agents.** Channel mentions only. DMs need `im:history` and a different
  addressing model (no channel to bind).
- **Editing or deleting a reply** after it is posted, beyond the single `chat.update`
  that resolves the placeholder.

## Acceptance

- An `@mention` naming a teammate in a bound channel runs that agent as the mentioning
  human and answers in thread under the teammate's name and avatar.
- A bare mention in a bound channel runs the channel's default agent; a bare mention in
  an unbound channel asks which teammate; a named teammate that matches nothing asks.
- A mention from a Slack user with no `SlackIdentity` row runs nothing, spends no
  tokens, and replies with a link prompt.
- The same message arriving as both `message.channels` and `app_mention` produces two
  ActivityEvent rows, and the mention is dispatched exactly once.
- A redelivered `app_mention` does not produce a second run or a second reply.
- An agent's own reply does not re-trigger it; depth-capped events stop.
- A follow-up in the same thread continues the same `AgentChatSession`.
- A run needing approval posts an in-thread link and does not proceed until decided.
- A failed run updates its placeholder with a failure line rather than going silent.
- `slack_mention` runs count as human-initiated in `automationRatio` and are counted
  in `engagedUsers`.
- A customer workspace with no signing secret of its own verifies against the
  app-level `SLACK_SIGNING_SECRET`, while a customer workspace with no bot token of
  its own still resolves **no** bot token — pinned by test, so narrowing the one
  cannot silently widen the other.
- Gates: tsc, lint, unit, CI-mode DB suite; migrations via `prisma migrate deploy`;
  new RLS models covered by the RLS coverage test and placed in the demo snapshot
  engine. Fly worker redeploy **required** — the agent runtime's completion path
  changes.
