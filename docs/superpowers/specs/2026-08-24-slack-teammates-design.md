# Slack Teammates — one platform-owned app, agents summonable by @mention — Design

Date: 2026-08-24
Status: approved for autonomous execution (continuous-execution workflow)
Origin: monday.com AI-first gap analysis, gap 1 of 4 (build order 3 → 1 → 5 → 6). Gap 3 shipped 2026-08-24.

## Goal

A workspace clicks **Add to Slack** once, and from then on a person mentions a
teammate in Slack and it does the work there — answering in thread, under that
teammate's own name and face, with the tool access of the person who asked.

Nobody creates a Slack app, and nobody handles a token.

Today Slack is a *trigger source*, not a place a teammate lives. `/api/slack/events`
receives signed deliveries and normalizes them to `message.posted` / `generic`;
`dispatchActivityEvent` fans those out to **flows**. There is no `app_mention`
handling, no agent dispatch, no threaded reply, and no way to address one agent out
of a roster. So agents remain reachable only by going to Backstory — the "AI chat
running parallel to the work" shape the gap analysis identified, just with a nicer
chat.

## Why the platform owns the app

The BYO-app model in place today has failed operationally, in a specific and
recurring way: an individual creates the Slack app, that person leaves, and nobody
can reach its settings again. The workspace is left with a bot it cannot administer
and cannot replace without starting over. Alongside that, every new integration
meant another rarely-used bot in a Slack workspace already carrying too many.

So Backstory owns one Slack app, and workspaces install it. App configuration lives
with the platform rather than with whoever happened to create it, which means no
individual's departure can orphan it.

**A bot token cannot be embedded, and this is Slack's constraint rather than a
choice.** `oauth.v2.access` mints a *distinct* `xoxb-` per workspace install; there
is no single token that works across workspaces. The platform-owned model is
therefore not "one embedded token" but "one embedded **app identity**"
(`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`) plus per-install
tokens that Slack mints and the callback stores automatically. No human sees one.

That distinction is what keeps the platform-owned model compatible with the guard in
`org-credential.test.ts`: a shared bot token would be a shared *identity* and stays
refused; per-install tokens are exactly what that guard wants.

BYO remains supported as an escape hatch for a workspace that insists on its own app —
the existing paste path, unchanged.

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

## Architecture (six layers)

### 0. Install → "Add to Slack"

Two routes, following the state-validated OAuth pattern already used by
`mcp-connections/oauth/callback` and `peopleai/callback` (both declared in
`UNGATED_ROUTES` for the same reason):

- **`GET /api/slack/install`** — authenticated. Redirects to Slack's
  `oauth/v2/authorize` with the app's client id, the bot scopes below, and a signed,
  short-lived `state` binding the install to the requesting organization and user.
- **`GET /api/slack/oauth/callback`** — ungated by session (Slack is the caller),
  authenticated *by the state parameter*, which must verify and be unexpired before
  anything is written. It exchanges the code via `oauth.v2.access` and stores the
  result.

`oauth.v2.access` returns `access_token`, `team.id` and `bot_user_id` in one payload,
so the install writes the same `IntegrationSecret` shape the paste path produces —
`authConfig.teamId` / `authConfig.botUserId` included. **Every existing consumer is
untouched**: the events receiver, `getSlackToken`, `findSlackWorkspaceByTeamId` and
the native-plane reads all keep working, because only acquisition changed, not
storage.

The existing `findConflictingSlackOrg` check applies unchanged and is now more
load-bearing, not less: with one shared app, two Backstory organizations installing
into the *same* Slack workspace is a realistic mistake rather than a theoretical one,
and it must be refused rather than silently misrouting every delivery.

Re-installing overwrites the stored token, which is the recovery path when a token is
revoked or lost — no human intervention, no support ticket.

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

**These are two separate acts and the UI must not blur them**, because with a
platform-owned app it is natural to assume the install covers everyone:

| Act | Who | Produces | Grants |
| --- | --- | --- | --- |
| Install the Backstory app | a workspace admin, once | org bot token | the app can receive mentions and post replies |
| Link your own Slack | each person, once | `SlackIdentity` + their personal Nango connection | *that person* can summon agents, and their agents act as them |

The install alone lets nobody summon anything. That is the fail-closed rule in layer 2
working as intended, not a bug — but it is also the most likely support question, so
the install's success screen says plainly that each person still links their own
account, and the unlinked-mention reply says the same thing in context.

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
6. **The platform-owned app is the default path; BYO is the escape hatch.** The two
   coexist — but that needs one deliberate change, not zero. `resolveSigningSecretForOrg` prefers a workspace's own signing
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

**Platform-embedded, in Vercel env (Production + Preview)** — the app's own identity,
shared across every install and handled by no human after being set once:

| Variable | Source |
| --- | --- |
| `SLACK_CLIENT_ID` | Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | Basic Information → App Credentials |
| `SLACK_SIGNING_SECRET` | Basic Information → App Credentials |

None are currently in `.env.example`; this workstream documents all three there and in
the runbook. `SLACK_BOT_TOKEN` stays **unset** — a shared bot token is a shared
identity, and per-install tokens make it unnecessary.

**In the Slack app itself:** bot scopes `app_mentions:read`, `chat:write`,
`chat:write.customize`; event subscription `app_mention`; redirect URL
`https://<host>/api/slack/oauth/callback`; Request URL `https://<host>/api/slack/events`
(unchanged — the same shared route, routed by `team_id`).

`chat:write.customize` earns its place: without it every teammate posts as one
undifferentiated bot, and a roster of distinguishable teammates is the point.

`docs/runbooks/activity-plane.md` §5 currently documents the BYO path as the only
model; this workstream rewrites it to lead with install and keep BYO as the exception.

## Out of scope (this workstream)

- **Slack interactive approvals (gap 1b).** Block Kit Approve/Reject buttons need a
  second signed endpoint (`/api/slack/interactions`), its own signature verification,
  and an authorization check that the person pressing the button may decide this
  approval. That last item is a real authorization surface and gets its own spec
  immediately after this one.
- **DMs to agents.** Channel mentions only. DMs need `im:history` and a different
  addressing model (no channel to bind).
- **Editing or deleting a reply** after it is posted, beyond the single `chat.update`
  that resolves the placeholder.

## Acceptance

- A workspace admin clicks Add to Slack, approves in Slack, and the workspace is
  connected with no token ever shown to or handled by a person.
- The callback refuses a missing, tampered, expired, or replayed `state` before
  writing anything.
- Installing into a Slack workspace another organization already claims is refused by
  `findConflictingSlackOrg`, not silently misrouted.
- Re-installing an already-connected workspace overwrites its token and leaves it
  working.
- A BYO workspace that saved its own token and signing secret keeps working unchanged.
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
