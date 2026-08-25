# Slack Teammates (Mentions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person @mentions a teammate in Slack and it does the work there — answering in thread, under that teammate's own name and face, with the tool access of the person who asked.

**Architecture:** `app_mention` events are normalized into a new `agent.mentioned` activity kind under their own `sourceEventId` namespace, then routed by a dedicated dispatcher (not the flow-only `dispatchActivityEvent`) that resolves the asking human via `SlackIdentity`, resolves the teammate via an explicit name or a channel binding, and starts an ordinary agent run keyed for exactly-once by `AgentExecution.idempotencyKey`. The run's completion path posts the answer back into the thread.

**Tech Stack:** Next.js App Router, Prisma + PostgreSQL, `node:test` + `node:assert/strict`, Slack Events API + Web API.

**Spec:** `docs/superpowers/specs/2026-08-24-slack-teammates-design.md` (layers 1–5)

## Global Constraints

- **Plan B of two.** Plan A (`slack-app-install`, shipped `0bba8f97`) built the platform-owned install. This plan assumes a workspace has a bot token and `botUserId` stored — however acquired.
- **Fail closed on identity.** A mention from a Slack user with no `SlackIdentity` row runs nothing, spends no model tokens, and consumes no run allowance. It replies with a link prompt.
- **`sourceEventId` for mentions is `slack:mention:{channel}:{ts}`**, never `slack:msg:…`. Slack delivers the same message as both `message.channels` and `app_mention`; they collide on the existing `@@unique([organizationId, source, sourceEventId])` and the mention would be swallowed as a redelivery.
- **Every outgoing post stamps chain depth.** `metadata: { event_type: 'flow_message', event_payload: { chainDepth } }`, matching `applySlackChainDepthMetadata` in `src/features/flows/tool-args.ts`. `chainDepthFromMetadata` reads it back and `ACTIVITY_CHAIN_DEPTH_CAP` (3) is what stops an agent answering itself forever.
- **`skipApprovalGate` is never set** for a mention run. Flow-invoked runs bypass approvals because a flow runs end to end; a mention is interactive and must stop.
- **`slack_mention` counts as human-initiated** in `automationRatio` and `engagedUsers` (`src/lib/adoption/compute.ts`). A human mentioning an agent is the most human-initiated act in the product; left alone it would inflate the automation ratio and make the AI-dust detector wrong in the flattering direction.
- New models get `ENABLE`+`FORCE` RLS with a `tenant_isolation` policy, go into `ORG_SCOPED_MODELS` (`src/lib/tenant-guard.ts`), and must be placed in the demo snapshot engine's `EXCLUDED`/`COPY_*` lists (`src/lib/demo/snapshot.ts`) or `src/lib/demo/__tests__/model-coverage.test.ts` fails.
- DB tests run concurrently against a shared CI-mode database (`ci_repro` locally). Delta-scoped assertions; every suite cleans up its own orgs.
- Run a single test file with: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test <path>`
- **Never `git stash` to check whether a failure is pre-existing** — run the suspect file directly. A stash on this machine can collide with a concurrent session's.

---

### Task 1: Schema — identity, channel bindings, thread continuity

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260824140000_slack_teammates/migration.sql`
- Modify: `src/lib/tenant-guard.ts` (`ORG_SCOPED_MODELS`)
- Modify: `src/lib/demo/snapshot.ts` (`EXCLUDED`)
- Test: `src/lib/__tests__/rls-coverage.db.test.ts`, `src/lib/demo/__tests__/model-coverage.test.ts` (both existing — must pass)

**Interfaces:**
- Consumes: nothing
- Produces: Prisma models `SlackIdentity`, `SlackChannelBinding`; `AgentChatSession.slackChannelId` / `.slackThreadTs`

- [ ] **Step 1: Add the models and columns to `prisma/schema.prisma`**

Add to the existing `AgentChatSession` model, after `title`:

```prisma
  /// Slack thread this conversation lives in, when it was started by a mention.
  /// Unique together so a follow-up in the same thread continues the SAME
  /// session instead of starting a new one every time. Null for in-app
  /// sessions, and Postgres treats NULLs as distinct in a unique index, so any
  /// number of them coexist.
  slackChannelId String?
  slackThreadTs  String?
```

and add to its attribute block:

```prisma
  @@unique([slackChannelId, slackThreadTs])
```

Append both new models:

```prisma
/// Which Backstory user a Slack user is.
///
/// Written when a person connects THEIR OWN Slack (a per-user NangoConnection),
/// from auth.test against their token — never from the bot token, which knows
/// only the app.
///
/// A dedicated model rather than NangoConnection.metadata because this is read
/// on every mention. findSlackWorkspaceByTeamId documents that its JSON-blob
/// table scan was acceptable precisely BECAUSE it is not a hot path; this one
/// is, and gets a real unique index.
model SlackIdentity {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  /// Slack's `U…` id, as it arrives on an event's `actorExternalId`.
  slackUserId    String
  userId         String
  verifiedAt     DateTime @default(now()) @db.Timestamptz(6)
  createdAt      DateTime @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// Cascade, NOT SetNull: an identity row with no user would let a mention
  /// resolve to nobody while still LOOKING linked. Deprovisioning a person must
  /// take their Slack link with them.
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([organizationId, slackUserId])
  @@index([userId])
  @@map("slack_identities")
}

/// The teammate a bare @mention reaches in a given channel.
model SlackChannelBinding {
  id             String   @id @default(cuid())
  organizationId String   @db.Uuid
  channelId      String
  agentTaskId    String
  createdAt      DateTime @default(now()) @db.Timestamptz(6)
  updatedAt      DateTime @updatedAt @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  /// Cascade: a binding to a deleted agent would send every bare mention in the
  /// channel to a teammate that no longer exists.
  agentTask    AgentTask    @relation(fields: [agentTaskId], references: [id], onDelete: Cascade)

  @@unique([organizationId, channelId])
  @@index([agentTaskId])
  @@map("slack_channel_bindings")
}
```

Add the back-relations. On `Organization`, beside `adoptionWeeks`:

```prisma
  slackIdentities       SlackIdentity[]
  slackChannelBindings  SlackChannelBinding[]
```

On `User`, beside `apiKeys`:

```prisma
  slackIdentities     SlackIdentity[]
```

On `AgentTask`, beside `memories`:

```prisma
  slackChannelBindings SlackChannelBinding[]
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20260824140000_slack_teammates/migration.sql`. The RLS block copies `20260824130000_adoption_rollups`:

```sql
-- Slack teammates: who a Slack user is, which teammate a channel reaches, and
-- which thread a conversation belongs to.

ALTER TABLE "agent_chat_sessions" ADD COLUMN "slackChannelId" TEXT;
ALTER TABLE "agent_chat_sessions" ADD COLUMN "slackThreadTs" TEXT;

-- Plain, NOT partial, so it matches the schema's @@unique exactly — a partial
-- index here would read as permanent drift to `prisma migrate diff`. It is
-- still safe for the millions of in-app sessions that leave both columns null:
-- Postgres treats NULLs as distinct in a unique index, so any number of
-- all-null rows coexist.
CREATE UNIQUE INDEX "agent_chat_sessions_slackChannelId_slackThreadTs_key"
  ON "agent_chat_sessions"("slackChannelId", "slackThreadTs");

CREATE TABLE "slack_identities" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "slackUserId"    TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "verifiedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "slack_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_identities_organizationId_slackUserId_key"
  ON "slack_identities"("organizationId", "slackUserId");
CREATE INDEX "slack_identities_userId_idx" ON "slack_identities"("userId");

ALTER TABLE "slack_identities"
  ADD CONSTRAINT "slack_identities_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_identities"
  ADD CONSTRAINT "slack_identities_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "slack_channel_bindings" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" UUID NOT NULL,
  "channelId"      TEXT NOT NULL,
  "agentTaskId"    TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "slack_channel_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_channel_bindings_organizationId_channelId_key"
  ON "slack_channel_bindings"("organizationId", "channelId");
CREATE INDEX "slack_channel_bindings_agentTaskId_idx" ON "slack_channel_bindings"("agentTaskId");

ALTER TABLE "slack_channel_bindings"
  ADD CONSTRAINT "slack_channel_bindings_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_channel_bindings"
  ADD CONSTRAINT "slack_channel_bindings_agentTaskId_fkey"
  FOREIGN KEY ("agentTaskId") REFERENCES "agent_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation, same shape as every other org-scoped table. Enabling RLS
-- without a policy is deny-all in PostgreSQL, so the policy ships in the same
-- statement block as the enable -- see 20260818130000 for the full rationale.
DO $rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['slack_identities', 'slack_channel_bindings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)
         WITH CHECK ("organizationId" = nullif(current_setting(''app.organization_id'', true), '''')::uuid)', t);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backstory_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO backstory_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM authenticated', t);
    END IF;
  END LOOP;
END
$rls$;
```

- [ ] **Step 3: Register in the tenant guard**

In `src/lib/tenant-guard.ts`, after the `'AdoptionWeek', 'AgentCohortWeek',` line:

```ts
  'SlackIdentity', 'SlackChannelBinding',
```

- [ ] **Step 4: Place both models in the demo snapshot engine**

In `src/lib/demo/snapshot.ts`, add to `EXCLUDED`:

```ts
  SlackIdentity: 'binds a REAL person to a real Slack account; a sandbox must never be able to act as either, and demo transports do not reach Slack at all',
  SlackChannelBinding: 'points at real Slack channels in the real workspace; meaningless in a sandbox whose Slack transport is canned',
```

- [ ] **Step 5: Generate, migrate, and verify both guards**

Run:
```bash
npx prisma generate && npx prisma migrate deploy
TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/__tests__/rls-coverage.db.test.ts src/lib/demo/__tests__/model-coverage.test.ts
```
Expected: migration applied; both suites PASS.

- [ ] **Step 6: Verify RLS landed in the database itself**

Run:
```bash
psql "$TEST_DATABASE_URL" -c "SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, count(p.polname) AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname='public' AND c.relname IN ('slack_identities','slack_channel_bindings') GROUP BY 1,2,3;"
```
Expected: both rows `rls=t forced=t policies=1`. A passing coverage test with RLS off in the database means the `DO $rls$` block did not run.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add prisma/schema.prisma prisma/migrations/20260824140000_slack_teammates src/lib/tenant-guard.ts src/lib/demo/snapshot.ts
git commit -m "feat(slack): schema for teammate identity, channel bindings and threads

SlackIdentity is a dedicated model rather than NangoConnection metadata
because it is read on every mention — findSlackWorkspaceByTeamId
documents that its JSON-blob scan was tolerable only because it is NOT a
hot path.

Both FKs cascade deliberately: an identity row with no user would let a
mention resolve to nobody while still looking linked, and a binding to a
deleted agent would send every bare mention to a teammate that no longer
exists.

The thread index is partial so the millions of in-app sessions with both
columns null do not collide with each other.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mention parsing and teammate resolution

Pure, so every resolution rule is testable without a database or Slack.

**Files:**
- Create: `src/lib/slack/mention.ts`
- Test: `src/lib/slack/__tests__/mention.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface MentionAgent { id: string; name: string; roleLabel?: string | null }`
  - `stripBotMention(text: string, botUserId: string): string`
  - `type MentionResolution = { kind: 'agent'; agent: MentionAgent; prompt: string } | { kind: 'ask'; candidates: MentionAgent[]; reason: 'no-name' | 'no-match' } | { kind: 'none' }`
  - `resolveMention(params: { text: string; botUserId: string; agents: MentionAgent[]; boundAgentId?: string | null }): MentionResolution`

- [ ] **Step 1: Write the failing test**

Create `src/lib/slack/__tests__/mention.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripBotMention, resolveMention, type MentionAgent } from '@/lib/slack/mention'

const BOT = 'U0BOT'
const agents: MentionAgent[] = [
  { id: 'a1', name: 'Scout', roleLabel: 'Account research' },
  { id: 'a2', name: 'Ledger', roleLabel: 'Spend review' },
  { id: 'a3', name: 'Pulse', roleLabel: null },
]

test('stripBotMention removes the bot mention wherever it sits', () => {
  assert.equal(stripBotMention(`<@${BOT}> what changed?`, BOT), 'what changed?')
  assert.equal(stripBotMention(`hey <@${BOT}> what changed?`, BOT), 'hey what changed?')
  // Another person's mention is CONTENT, not addressing — it must survive.
  assert.equal(stripBotMention(`<@${BOT}> ask <@U9OTHER> too`, BOT), 'ask <@U9OTHER> too')
})

test('an explicit name resolves that teammate and keeps the rest as the prompt', () => {
  const result = resolveMention({ text: `<@${BOT}> Scout what changed on Acme?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'agent')
  if (result.kind !== 'agent') return
  assert.equal(result.agent.id, 'a1')
  assert.equal(result.prompt, 'what changed on Acme?')
})

test('the name match is case-insensitive and tolerates punctuation', () => {
  for (const text of [`<@${BOT}> scout, what changed?`, `<@${BOT}> SCOUT: what changed?`]) {
    const result = resolveMention({ text, botUserId: BOT, agents })
    assert.equal(result.kind, 'agent', text)
    if (result.kind === 'agent') assert.equal(result.agent.id, 'a1')
  }
})

test('a role label resolves too, so people can address the work', () => {
  const result = resolveMention({ text: `<@${BOT}> spend review how much last month?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') {
    assert.equal(result.agent.id, 'a2')
    assert.equal(result.prompt, 'how much last month?')
  }
})

test('a bare mention uses the channel binding', () => {
  const result = resolveMention({ text: `<@${BOT}> what changed?`, botUserId: BOT, agents, boundAgentId: 'a3' })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') {
    assert.equal(result.agent.id, 'a3')
    assert.equal(result.prompt, 'what changed?')
  }
})

test('a bare mention with no binding asks', () => {
  const result = resolveMention({ text: `<@${BOT}> what changed?`, botUserId: BOT, agents })
  assert.equal(result.kind, 'ask')
  if (result.kind === 'ask') {
    assert.equal(result.reason, 'no-name')
    assert.equal(result.candidates.length, 3)
  }
})

test('a named teammate that matches nothing ASKS rather than falling back', () => {
  // Running a different teammate than the one someone named is worse than
  // asking — this is the ruling that keeps the binding from silently
  // overriding an explicit request.
  const result = resolveMention({
    text: `<@${BOT}> Sprocket what changed?`,
    botUserId: BOT,
    agents,
    boundAgentId: 'a3',
  })
  assert.equal(result.kind, 'ask')
  if (result.kind === 'ask') assert.equal(result.reason, 'no-match')
})

test('a bare mention with no text and a binding still runs, with an empty prompt', () => {
  const result = resolveMention({ text: `<@${BOT}>`, botUserId: BOT, agents, boundAgentId: 'a1' })
  assert.equal(result.kind, 'agent')
  if (result.kind === 'agent') assert.equal(result.prompt, '')
})

test('an empty roster is none, not ask — there is nothing to offer', () => {
  const result = resolveMention({ text: `<@${BOT}> hello`, botUserId: BOT, agents: [] })
  assert.equal(result.kind, 'none')
})

test('a binding pointing at an agent no longer in the roster asks', () => {
  // The FK cascade removes bindings for deleted agents, but an agent can also
  // become invisible to this reader. Asking beats running nothing silently.
  const result = resolveMention({ text: `<@${BOT}> hi`, botUserId: BOT, agents, boundAgentId: 'gone' })
  assert.equal(result.kind, 'ask')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/mention.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/mention'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/slack/mention.ts`:

```ts
/**
 * Who was addressed, and what they were asked.
 *
 * Pure so every resolution rule is testable without a database or Slack. The
 * roster shape is deliberately minimal (id/name/roleLabel) rather than reusing
 * buildRoster's card types — the caller maps, and this module stays about
 * matching.
 */

export interface MentionAgent {
  id: string
  name: string
  roleLabel?: string | null
}

export type MentionResolution =
  | { kind: 'agent'; agent: MentionAgent; prompt: string }
  | { kind: 'ask'; candidates: MentionAgent[]; reason: 'no-name' | 'no-match' }
  | { kind: 'none' }

/**
 * Remove the bot's own mention, leaving what was actually said.
 *
 * Only the BOT's mention is stripped: another person's `<@U…>` is content
 * ("ask Dana too") and must survive into the prompt.
 */
export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase, strip punctuation, collapse whitespace — for comparison only. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Does `body` open with `label`? Returns the remaining prompt if so.
 *
 * Matched on the NORMALIZED forms but sliced from the ORIGINAL body by word
 * count, so stripping punctuation for comparison never mangles the prompt the
 * user actually typed.
 */
function matchLeading(body: string, label: string): string | null {
  const normalizedLabel = normalize(label)
  if (!normalizedLabel) return null
  const labelWords = normalizedLabel.split(' ')
  const bodyWords = body.split(/\s+/).filter(Boolean)
  if (bodyWords.length < labelWords.length) return null
  const leading = normalize(bodyWords.slice(0, labelWords.length).join(' '))
  if (leading !== normalizedLabel) return null
  return bodyWords.slice(labelWords.length).join(' ')
}

export function resolveMention(params: {
  text: string
  botUserId: string
  agents: MentionAgent[]
  boundAgentId?: string | null
}): MentionResolution {
  const { agents } = params
  // Nothing to offer and nothing to run. Asking "which teammate?" against an
  // empty roster would be a dead end.
  if (agents.length === 0) return { kind: 'none' }

  const body = stripBotMention(params.text, params.botUserId)

  // 1. An explicit name or role label wins over any binding.
  //    Longest label first, so "Spend review" is not shadowed by a teammate
  //    called "Spend".
  const labelled = agents
    .flatMap((agent) => [
      { agent, label: agent.name },
      ...(agent.roleLabel ? [{ agent, label: agent.roleLabel }] : []),
    ])
    .sort((a, b) => normalize(b.label).length - normalize(a.label).length)

  for (const { agent, label } of labelled) {
    const prompt = matchLeading(body, label)
    if (prompt !== null) return { kind: 'agent', agent, prompt }
  }

  // 2. A leading word that looks like an attempt to name someone, matching
  //    nothing, ASKS. Falling through to the channel default here would run a
  //    different teammate than the one the person named — worse than asking.
  //    "Looks like an attempt" is deliberately narrow: a single leading
  //    capitalised word that is not an ordinary question opener.
  const firstWord = body.split(/\s+/)[0] ?? ''
  const looksLikeAName =
    /^[A-Z][A-Za-z-]{1,}$/.test(firstWord.replace(/[^A-Za-z-]/g, '')) &&
    !QUESTION_OPENERS.has(normalize(firstWord))
  if (looksLikeAName) return { kind: 'ask', candidates: agents, reason: 'no-match' }

  // 3. The channel's default teammate.
  if (params.boundAgentId) {
    const bound = agents.find((agent) => agent.id === params.boundAgentId)
    // A binding whose agent is not in this roster asks rather than running
    // nothing silently.
    if (bound) return { kind: 'agent', agent: bound, prompt: body }
    return { kind: 'ask', candidates: agents, reason: 'no-name' }
  }

  // 4. Nothing named, no binding.
  return { kind: 'ask', candidates: agents, reason: 'no-name' }
}

/**
 * Words that open a question rather than name a teammate. Without this, "What
 * changed on Acme?" in an unbound channel would be read as an attempt to
 * address someone called "What".
 */
const QUESTION_OPENERS = new Set([
  'what', 'why', 'who', 'when', 'where', 'how', 'can', 'could', 'would', 'should',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'please', 'hey', 'hi', 'hello',
  'give', 'show', 'tell', 'find', 'make', 'run', 'send', 'draft', 'summarize', 'summarise',
])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/slack/__tests__/mention.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slack/mention.ts src/lib/slack/__tests__/mention.test.ts
git commit -m "feat(slack): resolve which teammate a mention addressed

Explicit name or role label wins, then the channel default, then ask.
Labels are matched longest-first so a two-word role is not shadowed by a
one-word name, and the prompt is sliced from the ORIGINAL text by word
count so normalising for comparison never mangles what was typed.

A leading word that looks like a name but matches nothing ASKS rather
than falling through to the channel default: running a different
teammate than the one someone named is worse than asking. Question
openers are excluded so 'What changed on Acme?' is not read as
addressing someone called What.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Ingest `app_mention`

**Files:**
- Modify: `src/lib/activity/normalize.ts`
- Test: `src/lib/activity/__tests__/mention-normalize.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2
- Produces: `ActivityKind` gains `'agent.mentioned'`; `normalizeSlackEvent` handles `type === 'app_mention'`

- [ ] **Step 1: Write the failing test**

Create `src/lib/activity/__tests__/mention-normalize.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEvent } from '@/lib/activity/normalize'

const ORG = '00000000-0000-0000-0000-000000000001'
const BOT = 'U0BOT'
const receivedAt = new Date('2026-08-24T12:00:00Z')

const envelope = (event: Record<string, unknown>) => ({
  team_id: 'T1',
  event_id: 'Ev123',
  event: { channel: 'C1', ts: '1750000000.000100', user: 'U9', ...event },
})

test('an app_mention normalizes to agent.mentioned', () => {
  const normalized = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(normalized)
  assert.equal(normalized.kind, 'agent.mentioned')
  assert.equal(normalized.actorExternalId, 'U9')
})

test('a mention gets its OWN sourceEventId namespace', () => {
  // Slack delivers the SAME message as both message.channels and app_mention.
  // They share channel and ts, so a shared namespace would collide on
  // @@unique([organizationId, source, sourceEventId]) and the mention would be
  // swallowed as a redelivery of the plain message.
  const message = normalizeSlackEvent(ORG, envelope({ type: 'message', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  const mention = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(message && mention)
  assert.equal(message.sourceEventId, 'slack:msg:C1:1750000000.000100')
  assert.equal(mention.sourceEventId, 'slack:mention:C1:1750000000.000100')
  assert.notEqual(message.sourceEventId, mention.sourceEventId)
})

test('the mention payload keeps the text and thread so the dispatcher can reply', () => {
  const normalized = normalizeSlackEvent(
    ORG,
    envelope({ type: 'app_mention', text: `<@${BOT}> Scout go`, thread_ts: '1749999999.000001' }),
    { botUserId: BOT, receivedAt },
  )
  assert.ok(normalized)
  const subject = normalized.subject as Record<string, unknown>
  assert.equal(subject.channelId, 'C1')
  assert.equal(subject.threadTs, '1749999999.000001')
  const payload = normalized.payload as Record<string, unknown>
  assert.equal((payload.event as Record<string, unknown>).text, `<@${BOT}> Scout go`)
})

test('a mention the bot itself authored is selfOrigin', () => {
  // The loop guard. An agent's own reply must never be read as a new request.
  const normalized = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', user: BOT }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(normalized)
  assert.equal(normalized.selfOrigin, true)
})

test('a mention carries chain depth back out of the message metadata', () => {
  const normalized = normalizeSlackEvent(
    ORG,
    envelope({
      type: 'app_mention',
      metadata: { event_type: 'flow_message', event_payload: { chainDepth: 2 } },
    }),
    { botUserId: BOT, receivedAt },
  )
  assert.ok(normalized)
  assert.equal(normalized.chainDepth, 2)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/mention-normalize.test.ts`
Expected: FAIL — `kind` is `'generic'` and `sourceEventId` is `slack:msg:…`.

- [ ] **Step 3: Add the kind**

In `src/lib/activity/normalize.ts`, add to `ACTIVITY_KINDS`, after `'message.posted',`:

```ts
  /** An @mention of the Backstory app — a person summoning a teammate. */
  'agent.mentioned',
```

- [ ] **Step 4: Handle `app_mention` in `normalizeSlackEvent`**

Replace the kind derivation:

```ts
  const kind: ActivityKind = type === 'message' ? 'message.posted' : 'generic'
```

with:

```ts
  const isMention = type === 'app_mention'
  const kind: ActivityKind = isMention ? 'agent.mentioned' : type === 'message' ? 'message.posted' : 'generic'
```

and the `sourceEventId` derivation:

```ts
  const sourceEventId =
    channelId && ts ? `slack:msg:${channelId}:${ts}` : (firstString([outer], ['event_id']) ?? sha256Id(type, outer))
```

with:

```ts
  // Slack delivers the SAME message as both `message.channels` and
  // `app_mention` when both are subscribed. They share `channel` and `ts`, so a
  // shared namespace collides on @@unique([organizationId, source,
  // sourceEventId]) and whichever lands second is dropped as a redelivery —
  // silently swallowing the mention. Two namespaces, because they are two
  // different facts about one message.
  const idPrefix = isMention ? 'slack:mention' : 'slack:msg'
  const sourceEventId =
    channelId && ts ? `${idPrefix}:${channelId}:${ts}` : (firstString([outer], ['event_id']) ?? sha256Id(type, outer))
```

- [ ] **Step 5: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test src/lib/activity/__tests__/mention-normalize.test.ts src/lib/activity/__tests__/`
Expected: PASS. The existing normalize suites must still pass — `message.posted` and its `slack:msg:` id are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/activity/normalize.ts src/lib/activity/__tests__/mention-normalize.test.ts
git commit -m "feat(slack): normalize app_mention into agent.mentioned

Mentions get their OWN sourceEventId namespace. Slack delivers the same
message as both message.channels and app_mention; they share channel and
ts, so one namespace collides on the uniqueness constraint and whichever
arrives second is dropped as a redelivery — silently swallowing the
mention. They are two different facts about one message and now persist
as two rows.

selfOrigin and chainDepth carry through unchanged; they matter more here
than anywhere else because an agent's reply lands back in the same
channel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Capture `SlackIdentity` when a person links their own Slack

**Files:**
- Create: `src/lib/slack/identity.ts`
- Modify: `src/app/api/nango/webhook/route.ts`
- Test: `src/lib/slack/__tests__/identity.db.test.ts`

**Interfaces:**
- Consumes: `SlackIdentity` from Task 1
- Produces: `captureSlackIdentity(params: { organizationId: string; userId: string; connectionId: string; providerConfigKey: string; proxy?: NangoProxy }): Promise<{ slackUserId: string } | null>`

- [ ] **Step 1: Write the failing DB test**

Create `src/lib/slack/__tests__/identity.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Capturing who a Slack user is, at connect time.
 *
 * Connect-time capture rather than a lazy first-mention lookup, for the same
 * reason the bot's teamId/botUserId are captured when its token is saved: at
 * mention time we have a Slack user id and nothing to resolve it against, and
 * guessing is what the fail-closed rule exists to prevent.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack identity (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let captureSlackIdentity: any
  let orgId: string
  let userId: string
  let otherUserId: string

  const proxyReturning = (body: Record<string, unknown>) => async () => ({ data: body })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ captureSlackIdentity } = await import('@/lib/slack/identity'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-id-${suffix}`, slug: `slack-id-${suffix}` },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `a-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const other = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `b-${suffix}@example.test`, organizationId: orgId },
    })
    otherUserId = other.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('a linked Slack account records the mapping', async () => {
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-1',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111', team_id: 'T1' }),
    })
    assert.deepEqual(result, { slackUserId: 'U111' })

    const row = await prisma.slackIdentity.findUnique({
      where: { organizationId_slackUserId: { organizationId: orgId, slackUserId: 'U111' } },
    })
    assert.ok(row)
    assert.equal(row.userId, userId)
  })

  test('re-linking the same person is idempotent', async () => {
    await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-1',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111' }),
    })
    const rows = await prisma.slackIdentity.findMany({ where: { organizationId: orgId, slackUserId: 'U111' } })
    assert.equal(rows.length, 1)
  })

  test('a Slack account moving to another person re-points, never duplicates', async () => {
    // Otherwise the unique constraint throws and the whole webhook 500s, or
    // worse the old mapping keeps winning and mentions run as the wrong human.
    await captureSlackIdentity({
      organizationId: orgId,
      userId: otherUserId,
      connectionId: 'conn-2',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: true, user_id: 'U111' }),
    })
    const rows = await prisma.slackIdentity.findMany({ where: { organizationId: orgId, slackUserId: 'U111' } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].userId, otherUserId)
  })

  test('a failed auth.test records nothing', async () => {
    // Slack answers HTTP 200 with ok:false. Writing a row from that would bind
    // a person to an empty Slack id and make every later mention ambiguous.
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-3',
      providerConfigKey: 'slack',
      proxy: proxyReturning({ ok: false, error: 'invalid_auth' }),
    })
    assert.equal(result, null)
    assert.equal(
      await prisma.slackIdentity.count({ where: { organizationId: orgId, slackUserId: '' } }),
      0,
    )
  })

  test('a proxy that throws is swallowed, not propagated', async () => {
    // This runs inside the Nango webhook. A Slack outage must not fail the
    // whole connection-mirroring path — the person is still connected, they
    // just cannot summon agents until it is retried.
    const result = await captureSlackIdentity({
      organizationId: orgId,
      userId,
      connectionId: 'conn-4',
      providerConfigKey: 'slack',
      proxy: async () => {
        throw new Error('slack unreachable')
      },
    })
    assert.equal(result, null)
  })
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/slack/__tests__/identity.db.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/identity'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/slack/identity.ts`:

```ts
/**
 * Who a Slack user is, captured when they link their own Slack account.
 *
 * Connect-time capture, not a lazy first-mention lookup — the same reasoning
 * that put the bot's teamId/botUserId on the credential at save time. At
 * mention time all we have is a `U…` id; if nothing already maps it, the
 * fail-closed rule refuses the run rather than guessing.
 *
 * The token belongs to the PERSON (a per-user NangoConnection), so `auth.test`
 * through the Nango proxy answers with their Slack identity, not the app's.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { defaultProxy, type NangoProxy } from '@/lib/nango/delivery'

export async function captureSlackIdentity(params: {
  organizationId: string
  userId: string
  connectionId: string
  providerConfigKey: string
  proxy?: NangoProxy
}): Promise<{ slackUserId: string } | null> {
  const proxy = params.proxy ?? defaultProxy()

  let slackUserId = ''
  try {
    const { data } = await proxy({
      method: 'POST',
      endpoint: '/auth.test',
      connectionId: params.connectionId,
      providerConfigKey: params.providerConfigKey,
    })
    const body = (data ?? {}) as Record<string, unknown>
    // Slack answers HTTP 200 even for a rejected token; `ok` is the real result.
    if (body.ok === true && typeof body.user_id === 'string') slackUserId = body.user_id
  } catch (error) {
    // Swallowed on purpose: this runs inside the Nango webhook, and a Slack
    // outage must not fail the whole connection-mirroring path. The person is
    // connected either way — they just cannot summon agents until this is
    // retried on their next reconnect.
    apiLogger.warn('slack identity capture failed', {
      organizationId: params.organizationId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  if (!slackUserId) return null

  // Upsert on (organizationId, slackUserId), NOT on the user: a Slack account
  // moving to a different person must RE-POINT the mapping. Keying it the other
  // way would either throw on the unique constraint and 500 the webhook, or
  // leave the stale mapping winning so mentions run as the wrong human.
  await systemPrisma.slackIdentity.upsert({
    where: { organizationId_slackUserId: { organizationId: params.organizationId, slackUserId } },
    update: { userId: params.userId, verifiedAt: new Date() },
    create: { organizationId: params.organizationId, slackUserId, userId: params.userId },
  })

  return { slackUserId }
}
```

- [ ] **Step 4: Call it from the Nango webhook**

In `src/app/api/nango/webhook/route.ts`, find where a connection is mirrored (around the `ownerUserId: conn.userId` write near line 170) and add, after the connection row is persisted:

```ts
      // Only a PERSONAL Slack connection carries a person's Slack identity; an
      // org-shared row (userId null) is the workspace's, and auth.test on it
      // would return the app rather than a human.
      if (conn.userId && (remote.provider_config_key ?? '').toLowerCase().includes('slack')) {
        const { captureSlackIdentity } = await import('@/lib/slack/identity')
        void captureSlackIdentity({
          organizationId: orgId,
          userId: conn.userId,
          connectionId: remote.connection_id,
          providerConfigKey: remote.provider_config_key,
        })
      }
```

Read the surrounding code first and match the local variable names — `remote` and `conn` are used above; confirm the exact field names for `connection_id` and `provider_config_key` in that scope before writing.

- [ ] **Step 5: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/slack/__tests__/identity.db.test.ts && npm run typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/slack/identity.ts src/lib/slack/__tests__/identity.db.test.ts src/app/api/nango/webhook/route.ts
git commit -m "feat(slack): capture a person's Slack identity when they link Slack

Connect-time capture, matching how the bot's teamId/botUserId are taken
when its token is saved. At mention time all we have is a U… id, and
guessing which human that is would spend someone else's run allowance and
expose their data to whoever can see the channel.

Upserted on (organizationId, slackUserId) rather than on the user, so a
Slack account moving to a different person re-points the mapping instead
of throwing on the constraint or leaving the stale one winning.

Failures are swallowed: this runs inside the Nango webhook and a Slack
outage must not fail connection mirroring.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Dispatch a mention to a run

**Files:**
- Create: `src/lib/slack/reply.ts`
- Create: `src/lib/slack/mention-dispatch.ts`
- Modify: `src/lib/outbox.ts` (route `agent.mentioned` to the mention dispatcher)
- Test: `src/lib/slack/__tests__/mention-dispatch.db.test.ts`

**Interfaces:**
- Consumes: `resolveMention` (Task 2), `SlackIdentity`/`SlackChannelBinding` (Task 1), `agent.mentioned` (Task 3)
- Produces:
  - `postTeammateMessage(params: { organizationId: string; channelId: string; threadTs: string; text: string; teammateName: string; avatarUrl?: string | null; chainDepth: number }): Promise<{ ts: string } | null>`
  - `updateTeammateMessage(params: { organizationId: string; channelId: string; ts: string; text: string }): Promise<boolean>`
  - `dispatchSlackMention(activityEventId: string): Promise<{ outcome: 'ran' | 'unlinked' | 'asked' | 'skipped'; reason?: string }>`

- [ ] **Step 1: Write the reply transport**

Create `src/lib/slack/reply.ts`:

```ts
/**
 * Posting as a teammate.
 *
 * The reply is the APP speaking as itself, wearing the teammate's name and
 * face — not the asking human. That is why it uses the workspace bot token and
 * why it needs chat:write.customize; a roster of teammates that all post as one
 * generic bot is the thing this feature exists to avoid.
 */

import { getSlackToken } from '@/lib/integrations/slack'
import { apiLogger } from '@/lib/logger'

const POST_URL = 'https://slack.com/api/chat.postMessage'
const UPDATE_URL = 'https://slack.com/api/chat.update'

/**
 * Chain-depth stamp, matching applySlackChainDepthMetadata in
 * src/features/flows/tool-args.ts. The receiver reads it straight back out via
 * chainDepthFromMetadata, which is what lets ACTIVITY_CHAIN_DEPTH_CAP stop an
 * agent answering its own reply forever.
 */
const chainMetadata = (chainDepth: number) => ({
  event_type: 'flow_message',
  event_payload: { chainDepth },
})

async function slackPost(url: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  // Slack always returns HTTP 200; the body's `ok` is the real result.
  return (await response.json()) as Record<string, unknown>
}

export async function postTeammateMessage(params: {
  organizationId: string
  channelId: string
  threadTs: string
  text: string
  teammateName: string
  avatarUrl?: string | null
  chainDepth: number
}): Promise<{ ts: string } | null> {
  const token = await getSlackToken(params.organizationId)
  if (!token) return null
  const body = await slackPost(POST_URL, token.value, {
    channel: params.channelId,
    thread_ts: params.threadTs,
    text: params.text,
    username: params.teammateName,
    ...(params.avatarUrl ? { icon_url: params.avatarUrl } : {}),
    metadata: chainMetadata(params.chainDepth),
  })
  if (body.ok !== true || typeof body.ts !== 'string') {
    apiLogger.warn('slack teammate post failed', { organizationId: params.organizationId, error: body.error })
    return null
  }
  return { ts: body.ts }
}

export async function updateTeammateMessage(params: {
  organizationId: string
  channelId: string
  ts: string
  text: string
}): Promise<boolean> {
  const token = await getSlackToken(params.organizationId)
  if (!token) return false
  const body = await slackPost(UPDATE_URL, token.value, {
    channel: params.channelId,
    ts: params.ts,
    text: params.text,
  })
  if (body.ok !== true) {
    apiLogger.warn('slack teammate update failed', { organizationId: params.organizationId, error: body.error })
    return false
  }
  return true
}
```

- [ ] **Step 2: Write the failing dispatch test**

Create `src/lib/slack/__tests__/mention-dispatch.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * Mention -> run, against a real database.
 *
 * The two cases that matter most are negative: an unlinked Slack user must
 * spend nothing, and a redelivered mention must not run twice. Both are ways
 * this surface could quietly cost money or double-post.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('mention dispatch (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let dispatchSlackMention: any
  let orgId: string
  let userId: string
  let agentId: string
  let posted: Array<Record<string, unknown>> = []

  const originalFetch = globalThis.fetch

  const seedMention = async (opts: { slackUser: string; text: string; channel?: string }) => {
    const ts = `${Date.now()}.${Math.floor(Math.random() * 100000)}`
    const channel = opts.channel ?? 'C1'
    const event = await prisma.activityEvent.create({
      data: {
        organizationId: orgId,
        source: 'slack',
        sourceEventId: `slack:mention:${channel}:${ts}`,
        kind: 'agent.mentioned',
        occurredAt: new Date(),
        actorExternalId: opts.slackUser,
        ownerUserId: null,
        visibility: 'org',
        selfOrigin: false,
        chainDepth: 0,
        subject: { channelId: channel, threadTs: ts },
        payload: { event: { text: opts.text, channel, ts } },
      },
    })
    return event.id
  }

  const runsFor = async () =>
    prisma.agentExecution.count({ where: { organizationId: orgId, agentTaskId: agentId } })

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))

    // Stub Slack so nothing dials out and we can see what was posted.
    globalThis.fetch = (async (input: any, init: any) => {
      posted.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, ts: '1750000000.000999' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    ;({ dispatchSlackMention } = await import('@/lib/slack/mention-dispatch'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-md-${suffix}`, slug: `slack-md-${suffix}` },
    })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `md-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const agent = await prisma.agentTask.create({
      data: {
        organizationId: orgId, userId, description: 'Scout', objective: 'research',
        metadata: { title: 'Scout' },
      },
    })
    agentId = agent.id

    // The workspace has a bot token, as Plan A's install would have written.
    await prisma.integrationSecret.create({
      data: {
        organizationId: orgId, provider: 'slack', authType: 'api_key', isActive: true,
        authConfig: { authType: 'api_key', apiKey: (await import('@/lib/crypto/secrets')).encryptSecret('xoxb-test'), teamId: `T${suffix}`, botUserId: 'U0BOT' },
      },
    })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('an unlinked Slack user runs nothing and is told to link', async () => {
    posted = []
    const before = await runsFor()
    const eventId = await seedMention({ slackUser: 'U_UNKNOWN', text: '<@U0BOT> Scout go' })

    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'unlinked')
    assert.equal(await runsFor(), before, 'an unlinked mention must not start a run')
    assert.equal(posted.length, 1, 'it still replies, so the person knows why nothing happened')
    assert.match(String((posted[0].body as any).text), /link/i)
  })

  test('a linked user with a named teammate starts exactly one run', async () => {
    await prisma.slackIdentity.create({
      data: { organizationId: orgId, slackUserId: 'U_LINKED', userId },
    })
    posted = []
    const before = await runsFor()
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> Scout what changed?' })

    const result = await dispatchSlackMention(eventId)
    assert.equal(result.outcome, 'ran')
    assert.equal(await runsFor(), before + 1)

    const execution = await prisma.agentExecution.findFirst({
      where: { organizationId: orgId, agentTaskId: agentId },
      orderBy: { startedAt: 'desc' },
    })
    // Runs as the ASKING human, not the agent's owner.
    assert.equal(execution.userId, userId)
    assert.equal((execution.trigger as any).type, 'slack_mention')
    assert.equal((execution.idempotencyKey ?? '').startsWith('mention:'), true)
  })

  test('a redelivered mention does not run or post twice', async () => {
    const eventId = await seedMention({ slackUser: 'U_LINKED', text: '<@U0BOT> Scout again' })
    await dispatchSlackMention(eventId)
    const afterFirst = await runsFor()
    posted = []

    const second = await dispatchSlackMention(eventId)
    assert.equal(second.outcome, 'skipped')
    assert.equal(await runsFor(), afterFirst, 'the idempotency key must absorb the replay')
    assert.equal(posted.length, 0, 'and it must not double-post')
  })

  test('a self-origin mention is ignored entirely', async () => {
    const ts = `${Date.now()}.5`
    const event = await prisma.activityEvent.create({
      data: {
        organizationId: orgId, source: 'slack', sourceEventId: `slack:mention:C1:${ts}`,
        kind: 'agent.mentioned', occurredAt: new Date(), actorExternalId: 'U0BOT',
        ownerUserId: null, visibility: 'org', selfOrigin: true, chainDepth: 0,
        subject: { channelId: 'C1', threadTs: ts }, payload: { event: { text: '<@U0BOT> hi' } },
      },
    })
    posted = []
    const before = await runsFor()
    const result = await dispatchSlackMention(event.id)
    assert.equal(result.outcome, 'skipped')
    assert.equal(await runsFor(), before)
    assert.equal(posted.length, 0)
  })

  test('a depth-capped mention is ignored, so a reply loop terminates', async () => {
    const ts = `${Date.now()}.6`
    const event = await prisma.activityEvent.create({
      data: {
        organizationId: orgId, source: 'slack', sourceEventId: `slack:mention:C1:${ts}`,
        kind: 'agent.mentioned', occurredAt: new Date(), actorExternalId: 'U_LINKED',
        ownerUserId: null, visibility: 'org', selfOrigin: false, chainDepth: 3,
        subject: { channelId: 'C1', threadTs: ts }, payload: { event: { text: '<@U0BOT> Scout loop' } },
      },
    })
    posted = []
    const before = await runsFor()
    const result = await dispatchSlackMention(event.id)
    assert.equal(result.outcome, 'skipped')
    assert.equal(await runsFor(), before)
  })
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/slack/__tests__/mention-dispatch.db.test.ts`
Expected: FAIL — `Cannot find module '@/lib/slack/mention-dispatch'`.

- [ ] **Step 4: Write the dispatcher**

Create `src/lib/slack/mention-dispatch.ts`:

```ts
/**
 * A mention becomes a run.
 *
 * Deliberately NOT dispatchActivityEvent: that path is flow-only and attributes
 * runs to `flow.userId` or the oldest active user in the org. That attribution
 * is defensible for a flow trigger its owner configured, and is exactly the
 * hole this design rejects for mentions — anyone who can see the channel would
 * otherwise borrow someone else's data access.
 */

import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { ACTIVITY_CHAIN_DEPTH_CAP } from '@/lib/activity/dispatch'
import { resolveMention, type MentionAgent } from '@/lib/slack/mention'
import { postTeammateMessage } from '@/lib/slack/reply'

type Outcome = { outcome: 'ran' | 'unlinked' | 'asked' | 'skipped'; reason?: string }

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export async function dispatchSlackMention(activityEventId: string): Promise<Outcome> {
  const event = await systemPrisma.activityEvent.findUnique({ where: { id: activityEventId } })
  if (!event || event.kind !== 'agent.mentioned') return { outcome: 'skipped', reason: 'not-a-mention' }

  // The agent's own reply lands back in this channel as another event. Both
  // guards are what stop it answering itself forever.
  if (event.selfOrigin) return { outcome: 'skipped', reason: 'self-origin' }
  if (event.chainDepth >= ACTIVITY_CHAIN_DEPTH_CAP) return { outcome: 'skipped', reason: 'depth-capped' }

  const subject = asRecord(event.subject)
  const channelId = typeof subject.channelId === 'string' ? subject.channelId : ''
  const threadTs = typeof subject.threadTs === 'string' ? subject.threadTs : ''
  if (!channelId || !threadTs) return { outcome: 'skipped', reason: 'no-thread' }

  const inner = asRecord(asRecord(event.payload).event)
  const text = typeof inner.text === 'string' ? inner.text : ''

  const credential = await systemPrisma.integrationSecret.findUnique({
    where: { organizationId_provider: { organizationId: event.organizationId, provider: 'slack' } },
    select: { authConfig: true },
  })
  const botUserId = String(asRecord(credential?.authConfig).botUserId ?? '')
  if (!botUserId) return { outcome: 'skipped', reason: 'no-bot-identity' }

  const reply = (body: string, name = 'Backstory') =>
    postTeammateMessage({
      organizationId: event.organizationId,
      channelId,
      threadTs,
      text: body,
      teammateName: name,
      chainDepth: event.chainDepth + 1,
    })

  // Fail closed. Guessing which human this is would spend their run allowance
  // and expose their data to anyone who can see the channel.
  const identity = event.actorExternalId
    ? await systemPrisma.slackIdentity.findUnique({
        where: {
          organizationId_slackUserId: {
            organizationId: event.organizationId,
            slackUserId: event.actorExternalId,
          },
        },
        select: { userId: true },
      })
    : null
  if (!identity) {
    await reply(
      'Connect your Slack account in Backstory first — I run as you, with your access, so I need to know who you are before I can help here.',
    )
    return { outcome: 'unlinked' }
  }

  const agents = await systemPrisma.agentTask.findMany({
    where: { organizationId: event.organizationId, status: { not: 'DELETED' } },
    select: { id: true, description: true, metadata: true },
    take: 300,
  })
  const roster: MentionAgent[] = agents.map((agent) => {
    const metadata = asRecord(agent.metadata)
    return {
      id: agent.id,
      name: String(metadata.title ?? agent.description ?? '').trim(),
      roleLabel: typeof metadata.roleLabel === 'string' ? metadata.roleLabel : null,
    }
  })

  const binding = await systemPrisma.slackChannelBinding.findUnique({
    where: { organizationId_channelId: { organizationId: event.organizationId, channelId } },
    select: { agentTaskId: true },
  })

  const resolution = resolveMention({ text, botUserId, agents: roster, boundAgentId: binding?.agentTaskId })
  if (resolution.kind === 'none') {
    await reply('There are no agents in this workspace yet.')
    return { outcome: 'asked', reason: 'empty-roster' }
  }
  if (resolution.kind === 'ask') {
    const names = resolution.candidates.slice(0, 8).map((agent) => agent.name).filter(Boolean)
    await reply(`Which teammate should take this? ${names.join(', ')}`)
    return { outcome: 'asked', reason: resolution.reason }
  }

  // Exactly-once without a third claim table: AgentExecution.idempotencyKey is
  // unique per org and already exists as the replay guard for signal-triggered
  // runs. A redelivered mention collides and is a no-op.
  const idempotencyKey = `mention:${event.id}:${resolution.agent.id}`
  const existing = await systemPrisma.agentExecution.findUnique({
    where: { organizationId_idempotencyKey: { organizationId: event.organizationId, idempotencyKey } },
    select: { id: true },
  })
  if (existing) return { outcome: 'skipped', reason: 'already-dispatched' }

  const placeholder = await reply(`_${resolution.agent.name} is on it…_`, resolution.agent.name)

  let execution
  try {
    execution = await systemPrisma.agentExecution.create({
      data: {
        agentType: 'CUSTOM',
        agentTaskId: resolution.agent.id,
        status: 'pending',
        input: { prompt: resolution.prompt },
        idempotencyKey,
        trigger: {
          type: 'slack_mention',
          channelId,
          threadTs,
          slackUserId: event.actorExternalId,
          activityEventId: event.id,
          chainDepth: event.chainDepth + 1,
          ...(placeholder ? { placeholderTs: placeholder.ts } : {}),
        },
        userId: identity.userId,
        organizationId: event.organizationId,
      },
    })
  } catch (error) {
    // A concurrent delivery won the unique key. That is the guard working.
    apiLogger.info('slack mention already dispatched', { activityEventId: event.id })
    return { outcome: 'skipped', reason: 'race-lost' }
  }

  const { dispatchAgentExecution } = await import('@/features/agents/dispatch')
  await dispatchAgentExecution({
    executionId: execution.id,
    agentId: resolution.agent.id,
    organizationId: event.organizationId,
    userId: identity.userId,
    input: resolution.prompt,
  })

  return { outcome: 'ran' }
}
```

- [ ] **Step 5: Route `agent.mentioned` from the outbox**

In `src/lib/outbox.ts`, inside `deliver`, replace the activity-dispatch branch body so mentions take their own path:

```ts
  if (event.topic === OUTBOX_TOPIC_ACTIVITY_DISPATCH) {
    const payload = isActivityDispatchPayload(event.payload) ? event.payload : null
    if (!payload) throw new Error('Invalid activity.dispatch outbox payload')
    // Mentions run AGENTS as the asking human; dispatchActivityEvent fans out to
    // FLOWS and attributes runs to the flow owner. Different question, different
    // path — see mention-dispatch.ts.
    const { systemPrisma } = await import('@/lib/prisma')
    const row = await systemPrisma.activityEvent.findUnique({
      where: { id: payload.activityEventId },
      select: { kind: true },
    })
    if (row?.kind === 'agent.mentioned') {
      const { dispatchSlackMention } = await import('@/lib/slack/mention-dispatch')
      await dispatchSlackMention(payload.activityEventId)
      return
    }
    const { dispatchActivityEvent } = await import('@/lib/activity/dispatch')
    await dispatchActivityEvent(payload.activityEventId)
    return
  }
```

- [ ] **Step 6: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/slack/__tests__/mention-dispatch.db.test.ts && npm run typecheck`
Expected: PASS, 5 tests; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/slack/reply.ts src/lib/slack/mention-dispatch.ts src/lib/outbox.ts src/lib/slack/__tests__/mention-dispatch.db.test.ts
git commit -m "feat(slack): dispatch a mention to a run as the asking human

Its own path, not dispatchActivityEvent: that one is flow-only and
attributes runs to the flow owner or the oldest active user. Defensible
for a flow trigger its owner configured; for a mention it would let
anyone who can see the channel borrow that person's data access.

Fail closed on identity — an unlinked Slack user starts no run and
spends no tokens, but still gets told why. Exactly-once reuses
AgentExecution.idempotencyKey, already the replay guard for
signal-triggered runs, so no third claim table.

selfOrigin and the depth cap are both checked, because the agent's own
reply lands back in the same channel as another mention event.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Reply when the run finishes, and continue the thread's conversation

**Files:**
- Create: `src/lib/slack/thread-session.ts`
- Modify: `src/lib/slack/mention-dispatch.ts` (record the human turn, carry thread context)
- Modify: `src/features/agents/execute-agent.ts` (completion path)
- Test: `src/lib/slack/__tests__/reply-on-finish.db.test.ts`, `src/lib/slack/__tests__/thread-session.db.test.ts`

**Interfaces:**
- Consumes: `updateTeammateMessage`, `postTeammateMessage` (Task 5); `trigger.placeholderTs` written by the dispatcher
- Produces: `finishSlackMention(params: { organizationId: string; trigger: unknown; teammateName: string; text: string }): Promise<void>` exported from `src/lib/slack/reply.ts`

- [ ] **Step 1: Write the thread-session module**

Without this, `AgentChatSession.slackChannelId` / `.slackThreadTs` from Task 1 are
dead columns and every follow-up in a thread starts from nothing.

Create `src/lib/slack/thread-session.ts`:

```ts
/**
 * A Slack thread IS a conversation, so it maps to one AgentChatSession.
 *
 * Without this every follow-up in a thread would start from nothing — "and what
 * about last quarter?" would arrive with no idea what "that" was, which is the
 * difference between a teammate and a stateless command line.
 */

import { systemPrisma } from '@/lib/prisma'

/** How much prior thread turns to replay. Enough for context, bounded so a long thread cannot grow the prompt without limit. */
const WINDOW = 10

export async function threadSession(params: {
  organizationId: string
  agentTaskId: string
  userId: string
  channelId: string
  threadTs: string
}): Promise<{ id: string; priorTurns: Array<{ role: string; content: string }> }> {
  const existing = await systemPrisma.agentChatSession.findUnique({
    where: { slackChannelId_slackThreadTs: { slackChannelId: params.channelId, slackThreadTs: params.threadTs } },
    select: { id: true, agentTaskId: true },
  })

  // A thread already owned by a DIFFERENT teammate keeps its owner: someone
  // naming another teammate mid-thread gets that teammate, but the shared
  // history stays where it is rather than being silently re-parented.
  if (existing) {
    const priorTurns = await systemPrisma.agentChatMessage.findMany({
      where: { sessionId: existing.id },
      orderBy: { createdAt: 'desc' },
      take: WINDOW,
      select: { role: true, content: true },
    })
    return { id: existing.id, priorTurns: priorTurns.reverse() }
  }

  const created = await systemPrisma.agentChatSession.create({
    data: {
      organizationId: params.organizationId,
      agentTaskId: params.agentTaskId,
      userId: params.userId,
      slackChannelId: params.channelId,
      slackThreadTs: params.threadTs,
    },
    select: { id: true },
  })
  return { id: created.id, priorTurns: [] }
}

export async function recordThreadTurn(params: {
  organizationId: string
  agentTaskId: string
  userId: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
}): Promise<void> {
  await systemPrisma.agentChatMessage.create({
    data: {
      organizationId: params.organizationId,
      agentTaskId: params.agentTaskId,
      userId: params.userId,
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
    },
  })
}

/** Prepend prior turns so a follow-up knows what it is following up on. */
export function withThreadContext(prompt: string, priorTurns: Array<{ role: string; content: string }>): string {
  if (priorTurns.length === 0) return prompt
  const transcript = priorTurns.map((turn) => `${turn.role === 'assistant' ? 'You' : 'They'}: ${turn.content}`).join('\n')
  return `Earlier in this Slack thread:\n${transcript}\n\nNow they ask: ${prompt}`
}
```

- [ ] **Step 2: Use it from the dispatcher**

In `src/lib/slack/mention-dispatch.ts`, after the idempotency check and before creating the execution:

```ts
  const { threadSession, recordThreadTurn, withThreadContext } = await import('@/lib/slack/thread-session')
  const session = await threadSession({
    organizationId: event.organizationId,
    agentTaskId: resolution.agent.id,
    userId: identity.userId,
    channelId,
    threadTs,
  })
  const prompt = withThreadContext(resolution.prompt, session.priorTurns)
  await recordThreadTurn({
    organizationId: event.organizationId,
    agentTaskId: resolution.agent.id,
    userId: identity.userId,
    sessionId: session.id,
    role: 'user',
    content: resolution.prompt,
  })
```

Then use `prompt` (not `resolution.prompt`) for both the execution's `input` and the `dispatchAgentExecution` call, and add `sessionId: session.id` to the `trigger` object so the completion path can record the assistant turn.

- [ ] **Step 3: Write the thread-session test**

Create `src/lib/slack/__tests__/thread-session.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('thread session (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let threadSession: any
  let recordThreadTurn: any
  let withThreadContext: any
  let orgId: string
  let userId: string
  let agentId: string
  const CHANNEL = `C${crypto.randomUUID().slice(0, 8)}`
  const THREAD = '1750000000.000001'

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    ;({ threadSession, recordThreadTurn, withThreadContext } = await import('@/lib/slack/thread-session'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({ data: { name: `ts-${suffix}`, slug: `ts-${suffix}` } })
    orgId = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `ts-${suffix}@example.test`, organizationId: orgId },
    })
    userId = user.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: orgId, userId, description: 'Scout', objective: 'o' },
    })
    agentId = agent.id
  })

  after(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('the same thread resolves to the same session', async () => {
    const first = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    const second = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    assert.equal(second.id, first.id, 'a follow-up must continue the conversation, not start a new one')
  })

  test('prior turns come back oldest-first, so the transcript reads forwards', async () => {
    const session = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    await recordThreadTurn({ organizationId: orgId, agentTaskId: agentId, userId, sessionId: session.id, role: 'user', content: 'what changed on Acme?' })
    await recordThreadTurn({ organizationId: orgId, agentTaskId: agentId, userId, sessionId: session.id, role: 'assistant', content: 'Two renewals slipped.' })

    const again = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: THREAD })
    assert.equal(again.priorTurns.length, 2)
    assert.equal(again.priorTurns[0].content, 'what changed on Acme?')
    assert.equal(again.priorTurns[1].content, 'Two renewals slipped.')
  })

  test('a different thread is a different conversation', async () => {
    const other = await threadSession({ organizationId: orgId, agentTaskId: agentId, userId, channelId: CHANNEL, threadTs: '1750000000.000002' })
    assert.equal(other.priorTurns.length, 0)
  })

  test('withThreadContext leaves a first message alone and frames a follow-up', () => {
    assert.equal(withThreadContext('hello', []), 'hello')
    const framed = withThreadContext('and last quarter?', [{ role: 'user', content: 'what changed?' }])
    assert.match(framed, /Earlier in this Slack thread/)
    assert.match(framed, /and last quarter\?/)
  })
}
```

- [ ] **Step 4: Add the finisher to `src/lib/slack/reply.ts`**

```ts
/**
 * Resolve a mention's placeholder with the run's outcome.
 *
 * Called from the run's COMPLETION path rather than the dispatcher: in queue
 * mode dispatchAgentExecution returns as soon as the job is enqueued, long
 * before there is anything to say. The Slack context travels on the execution's
 * `trigger`, which is already persisted.
 *
 * Failures update the same placeholder rather than going silent — a mention
 * that never gets answered is indistinguishable from the app being broken.
 */
export async function finishSlackMention(params: {
  organizationId: string
  trigger: unknown
  teammateName: string
  text: string
}): Promise<void> {
  const trigger = (params.trigger && typeof params.trigger === 'object' ? params.trigger : {}) as Record<string, unknown>
  if (trigger.type !== 'slack_mention') return

  const channelId = typeof trigger.channelId === 'string' ? trigger.channelId : ''
  const threadTs = typeof trigger.threadTs === 'string' ? trigger.threadTs : ''
  const placeholderTs = typeof trigger.placeholderTs === 'string' ? trigger.placeholderTs : ''
  const chainDepth = typeof trigger.chainDepth === 'number' ? trigger.chainDepth : 1
  if (!channelId) return

  // Slack hard-caps a message; a long answer is truncated with a pointer rather
  // than silently rejected by the API.
  const text = params.text.length > 3800 ? `${params.text.slice(0, 3800)}\n\n_(truncated — open the run in Backstory for the rest)_` : params.text

  if (placeholderTs) {
    const updated = await updateTeammateMessage({ organizationId: params.organizationId, channelId, ts: placeholderTs, text })
    if (updated) return
    // Fall through: the placeholder may have been deleted. A new message beats
    // no answer.
  }
  if (!threadTs) return
  await postTeammateMessage({
    organizationId: params.organizationId,
    channelId,
    threadTs,
    text,
    teammateName: params.teammateName,
    chainDepth,
  })
}
```

- [ ] **Step 5: Call it from the run's completion path**

In `src/features/agents/execute-agent.ts`, find where a run reaches a terminal status (where `status: 'completed'` and `status: 'failed'` are written on the `agentExecution` row) and add, after each terminal update:

```ts
      // Slack-initiated runs answer in the thread they came from. Reading the
      // Slack context off the persisted trigger keeps this to one call site and
      // means the queue path needs no extra job payload.
      void (async () => {
        const { finishSlackMention } = await import('@/lib/slack/reply')
        await finishSlackMention({
          organizationId: data.organizationId,
          trigger: execution.trigger,
          teammateName: teammateNameFor(agent),
          text: outputText,
        }).catch(() => undefined)
      })()
```

Read the surrounding code and bind `execution`, `agent`, and the final output text to whatever those are actually called in that scope. Add a small local helper for the teammate name, mirroring how the dispatcher derives it:

```ts
const teammateNameFor = (agent: { description: string; metadata: unknown }) => {
  const metadata = agent.metadata && typeof agent.metadata === 'object' ? (agent.metadata as Record<string, unknown>) : {}
  return String(metadata.title ?? agent.description ?? 'Backstory').trim() || 'Backstory'
}
```

On the failure path, pass a failure line as `text`:

```ts
text: `That run failed. ${errorMessage.slice(0, 300)}`
```

- [ ] **Step 6: Write the reply test**

Create `src/lib/slack/__tests__/reply-on-finish.db.test.ts`:

```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (!TEST_DB) test('slack reply on finish (skipped: TEST_DATABASE_URL not set)', { skip: true }, () => {})

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-key'

  let prisma: any
  let finishSlackMention: any
  let orgId: string
  let calls: Array<{ url: string; body: any }> = []
  const originalFetch = globalThis.fetch

  before(async () => {
    ;({ systemPrisma: prisma } = await import('@/lib/prisma'))
    globalThis.fetch = (async (input: any, init: any) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    ;({ finishSlackMention } = await import('@/lib/slack/reply'))

    const suffix = crypto.randomUUID().slice(0, 8)
    const org = await prisma.organization.create({
      data: { name: `slack-fin-${suffix}`, slug: `slack-fin-${suffix}` },
    })
    orgId = org.id
    await prisma.integrationSecret.create({
      data: {
        organizationId: orgId, provider: 'slack', authType: 'api_key', isActive: true,
        authConfig: { authType: 'api_key', apiKey: (await import('@/lib/crypto/secrets')).encryptSecret('xoxb-test'), teamId: `T${suffix}`, botUserId: 'U0BOT' },
      },
    })
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {})
  })

  test('a non-Slack trigger posts nothing', async () => {
    calls = []
    await finishSlackMention({ organizationId: orgId, trigger: { type: 'manual' }, teammateName: 'Scout', text: 'hi' })
    assert.equal(calls.length, 0)
  })

  test('a placeholder is updated in place rather than double-posted', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', placeholderTs: '1.5', chainDepth: 1 },
      teammateName: 'Scout',
      text: 'here is the answer',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /chat\.update/)
    assert.equal(calls[0].body.ts, '1.5')
    assert.equal(calls[0].body.text, 'here is the answer')
  })

  test('with no placeholder it posts into the thread, stamped with chain depth', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', chainDepth: 2 },
      teammateName: 'Scout',
      text: 'answer',
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /chat\.postMessage/)
    assert.equal(calls[0].body.thread_ts, '1.0')
    assert.equal(calls[0].body.username, 'Scout')
    // Without this the reply re-enters as depth 0 and the loop guard never trips.
    assert.equal(calls[0].body.metadata.event_payload.chainDepth, 2)
  })

  test('an over-long answer is truncated rather than rejected by Slack', async () => {
    calls = []
    await finishSlackMention({
      organizationId: orgId,
      trigger: { type: 'slack_mention', channelId: 'C1', threadTs: '1.0', placeholderTs: '1.5', chainDepth: 1 },
      teammateName: 'Scout',
      text: 'x'.repeat(5000),
    })
    assert.ok(calls[0].body.text.length < 4000)
    assert.match(calls[0].body.text, /truncated/)
  })
}
```

- [ ] **Step 7: Run the tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/slack/__tests__/reply-on-finish.db.test.ts src/lib/slack/__tests__/thread-session.db.test.ts && npm run typecheck`
Expected: PASS, 4 + 4 tests; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/slack/reply.ts src/lib/slack/thread-session.ts src/lib/slack/mention-dispatch.ts src/features/agents/execute-agent.ts src/lib/slack/__tests__/reply-on-finish.db.test.ts src/lib/slack/__tests__/thread-session.db.test.ts
git commit -m "feat(slack): answer in the thread when a mention's run finishes

Called from the run's completion path, not the dispatcher: in queue mode
dispatchAgentExecution returns as soon as the job is enqueued, long
before there is anything to say. The Slack context travels on the
execution's persisted trigger, so the queue payload needs nothing extra.

The placeholder is updated in place rather than double-posted, failures
update the same message rather than going silent, and every post stamps
chain depth — without it the reply re-enters as depth 0 and the loop
guard never trips.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Keep the adoption metrics honest

**Files:**
- Modify: `src/lib/adoption/compute.ts`
- Test: `src/lib/adoption/__tests__/compute.db.test.ts` (extend)

**Interfaces:**
- Consumes: `trigger.type = 'slack_mention'` (Task 5)
- Produces: nothing

- [ ] **Step 1: Add the failing assertions**

In `src/lib/adoption/__tests__/compute.db.test.ts`, extend the seeded executions so one is a Slack mention, and assert it counts as human-initiated. Add to the `seeded` array in `before`:

```ts
      { trigger: { type: 'slack_mention' }, status: 'completed' },
```

Then add a test after `'rolls the week up into one row per real organization'`:

```ts
  test('a Slack mention counts as human-initiated, not automation', async () => {
    // A human @mentioning an agent is the most human-initiated act in the
    // product. Counted as automated it would inflate the automation ratio and
    // make the AI-dust detector wrong in the flattering direction.
    await rollupWeek(WEEK)
    const row = await prisma.adoptionWeek.findUnique({
      where: { organizationId_weekStart: { organizationId: realOrgId, weekStart: WEEK } },
    })
    assert.equal(row.execTotal, 4)
    // 2 manual + 1 slack_mention are all human-initiated; only 'schedule' is not.
    assert.equal(row.execManual, 3)
    assert.deepEqual(row.execByTrigger, { manual: 2, schedule: 1, slack_mention: 1 })
  })
```

Update the existing assertions in `'rolls the week up into one row per real organization'` for the extra row: `execTotal` 3 → 4, `execManual` 2 → 3, and `execByTrigger` to `{ manual: 2, schedule: 1, slack_mention: 1 }`.

- [ ] **Step 2: Run to verify it fails**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/adoption/__tests__/compute.db.test.ts`
Expected: FAIL — `execManual` is 2, because `slack_mention` is currently counted as automated.

- [ ] **Step 3: Teach the rollup which triggers are human**

In `src/lib/adoption/compute.ts`, add above `rollupWeek`:

```ts
/**
 * Trigger types a HUMAN started directly.
 *
 * `automationRatio` asks whether agents run without being poked, so what
 * matters is who started the run, not which surface it came from. A Slack
 * mention is a person typing at an agent; counting it as automation would
 * inflate the ratio and make the AI-dust detector wrong in the flattering
 * direction — the one direction a health metric must never be wrong in.
 */
const HUMAN_TRIGGERS = new Set(['manual', 'slack_mention'])
```

and change the trigger accumulation from:

```ts
    if (type === 'manual') entry.execManual += n
```

to:

```ts
    if (HUMAN_TRIGGERS.has(type)) entry.execManual += n
```

In the engaged-users raw SQL, change both `e.trigger->>'type' = 'manual'` predicates to:

```sql
        AND e.trigger->>'type' IN ('manual', 'slack_mention')
```

- [ ] **Step 4: Run to verify it passes**

Run: `TSX_TSCONFIG_PATH=tsconfig.test.json TEST_DATABASE_URL=$TEST_DATABASE_URL npx tsx --test src/lib/adoption/__tests__/compute.db.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rename the column's meaning in the page copy**

`execManual` now means "human-initiated", not "clicked Run". In `src/app/admin/adoption/page.tsx`, the automation-ratio section's description already says "Share of runs that were not started by hand" — leave it; it is still true and now covers Slack. Add one clause so the reader knows mentions are included:

```tsx
            Share of runs that were not started by hand — a Slack mention counts as
            by hand, since a person typed it. An agent that only ever runs when a
            human pokes it is a chat window with an avatar, not a teammate. Weeks
            with no runs at all are a gap in the line, not a zero.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/adoption/compute.ts src/lib/adoption/__tests__/compute.db.test.ts src/app/admin/adoption/page.tsx
git commit -m "fix(adoption): count Slack mentions as human-initiated

automationRatio counts everything non-manual as automation, so
slack_mention would have inflated it — and a human @mentioning an agent
is the most human-initiated act in the product. Left alone the AI-dust
detector would have been wrong in the flattering direction, the one
direction a health metric must never be wrong in.

engagedUsers likewise: someone who only ever reaches agents from Slack is
an engaged human and was invisible to it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Channel bindings UI, docs, and the full gate

**Files:**
- Create: `src/app/api/slack/channel-bindings/route.ts`
- Modify: `src/app/agents/teammate-panel.tsx` (bind a channel to this teammate)
- Modify: `docs/runbooks/activity-plane.md`
- Modify: `src/app/api/__tests__/route-smoke.test.ts` (smoke case for the new authenticated route)

**Interfaces:**
- Consumes: `SlackChannelBinding` (Task 1)
- Produces: `GET/PUT/DELETE /api/slack/channel-bindings`

- [ ] **Step 1: Write the route**

Create `src/app/api/slack/channel-bindings/route.ts`:

```ts
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * Which teammate a bare @mention reaches in a given Slack channel.
 *
 * The agent is tenant-checked on write, deliberately: the foreign key alone
 * accepts ANY org's agent id, which would file a binding onto a stranger's
 * roster and route that channel's mentions into another workspace.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const bindings = await prisma.slackChannelBinding.findMany({
    where: { organizationId: auth.organizationId },
    select: { channelId: true, agentTaskId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return { success: true, bindings }
}, { permission: 'agent.read' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const { channelId, agentTaskId } = z
    .object({ channelId: z.string().trim().min(1).max(64), agentTaskId: z.string().min(1) })
    .parse(await request.json())

  const agent = await prisma.agentTask.findFirst({
    where: { id: agentTaskId, organizationId: auth.organizationId, status: { not: 'DELETED' } },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const binding = await prisma.slackChannelBinding.upsert({
    where: { organizationId_channelId: { organizationId: auth.organizationId, channelId } },
    update: { agentTaskId },
    create: { organizationId: auth.organizationId, channelId, agentTaskId },
    select: { channelId: true, agentTaskId: true },
  })
  return { success: true, binding }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { channelId } = z.object({ channelId: z.string().trim().min(1) }).parse(await request.json())
  await prisma.slackChannelBinding.deleteMany({
    where: { organizationId: auth.organizationId, channelId },
  })
  return { success: true }
}, { permission: 'agent.write' })
```

Register a smoke case in `src/app/api/__tests__/route-smoke.test.ts`'s `cases`:

```ts
    { name: 'GET /api/slack/channel-bindings', run: async () => (await import('../slack/channel-bindings/route')).GET(req('/api/slack/channel-bindings')) },
```

- [ ] **Step 2: Add binding controls to the teammate panel**

In `src/app/agents/teammate-panel.tsx`, add a "Slack channel" field: a text input for the channel id and a Save that `PUT`s the binding, plus the current binding with a Remove. Copy alongside it:

```tsx
<p className="text-sm text-muted-foreground">
  A bare @Backstory in this channel reaches this teammate. Naming another
  teammate in the message still goes to whoever is named.
</p>
```

- [ ] **Step 3: Document the mention flow**

Add to `docs/runbooks/activity-plane.md` §5, after the install section:

```markdown
### Summoning agents from Slack

Two things must be true, and they are separate:

1. **The workspace is connected** — Add to Slack, or a BYO app with
   `app_mentions:read`, `chat:write` and `chat:write.customize`, and
   `app_mention` subscribed.
2. **The person is linked** — each individual connects their own Slack from
   /integrations. Installing the app connects the WORKSPACE, not its people. An
   unlinked mention runs nothing and replies with a link prompt; that is the
   fail-closed identity rule, not a bug.

Addressing: `@Backstory Scout what changed on Acme?` names a teammate;
`@Backstory what changed?` uses the channel's bound teammate; naming nobody in
an unbound channel asks which teammate.
```

- [ ] **Step 4: Full gate in CI mode**

Run `npm run typecheck && npm run lint && npm test` with `TEST_DATABASE_URL`, `DATABASE_URL` and `DIRECT_URL` on the local `ci_repro` Postgres.
Expected: tsc clean, 0 lint errors, 0 test failures.

If a test fails, run that file directly to see whether it is pre-existing. **Do not `git stash`.**

- [ ] **Step 5: Record in the ledger and commit**

Append to `.superpowers/sdd/progress.md`: what shipped, the identity ruling, the double-delivery trap, the adoption-metric interaction, the final gate line, and the **required Fly worker redeploy** (the agent runtime's completion path changed).

```bash
git add -A
git commit -m "feat(slack): channel bindings, docs, and the teammates gate

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Fly worker redeploy is REQUIRED** after this plan. `execute-agent.ts` changes, and the worker runs it — without a redeploy, queue-mode runs will complete without ever answering in Slack.
- **`chat:write.customize` is what makes teammates distinguishable.** If replies all arrive as one generic bot, that scope is missing from the installed app; re-install after adding it, since scopes are granted at install.
- **Verifying end to end needs a real workspace.** The DB suites stub Slack entirely and cover identity, resolution, exactly-once, loop guards and the reply. The round trip is a post-deploy check: install, link your own Slack, bind a channel, mention a teammate.
- **The unlinked reply is the most common first experience.** Everyone hits it once, before linking. It is worth reading in the real client to check the wording lands.
