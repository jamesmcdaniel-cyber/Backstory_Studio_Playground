# User Access, RBAC, and Catalogue Publishing Review

**Date:** 2026-07-29
**Status:** Approved (design)
**Owner:** James McDaniel

## Problem

The platform has no way to distinguish a Backstory employee from a customer,
and no gate on what reaches the shared template catalogue. Three concrete
failures:

### 1. Any authenticated user can publish to the global catalogue

`AgentTemplate.visibility` and `FlowTemplate.visibility` are `'org' | 'global'`,
where `'global'` means "readable by every other workspace"
(`src/lib/templates/catalogue.ts:93-97` does a `systemPrisma` cross-org read of
the global slice). `POST /api/flow-templates` accepts `visibility` straight from
the request body (`src/app/api/flow-templates/route.ts:25`), and so does the
`PATCH` at `src/app/api/flow-templates/[id]/route.ts` via
`route.ts:82`. Nothing checks who the caller is. Any customer workspace can
push a template into the catalogue that every other customer then sees.

### 2. The community skill library has no gate at all

`SharedSkill` has no `visibility` column. `GET /api/skills` reads
`systemPrisma.sharedSkill.findMany({ where: { isActive: true } })`
(`src/app/api/skills/route.ts:47-52`) — every row, every org. `POST` writes
directly into that public library. This is the widest of the three holes:
publishing is not merely ungated, it is the *only* behavior.

### 3. There is no staff concept to gate on

`UserRole { ADMIN, USER }` is org-scoped: an ADMIN administers *their own*
workspace. There is no platform tier, so "Backstory employees may publish;
customers may not" is not expressible today. Only ~9 sites check the role at
all (`src/app/settings/page.tsx`, `src/app/api/organizations/members/[id]/route.ts`,
`src/app/api/invitations/accept/route.ts`, `src/components/flows/jam-dialog.tsx`,
`src/hooks/use-auth.ts`, `src/lib/supabase/auth-utils.ts`), each with an
ad-hoc inline comparison.

`TemplateProposal` already models a review queue, but for a different concept:
AI-generated, org-internal suggestions that a workspace admin accepts for their
*own* org. It is not a publishing pipeline and should not be overloaded into one.

## Goals

- A platform-level identity tier: Backstory internal, People.ai partner, customer.
- Backstory staff author, review, and publish catalogue entries. People.ai staff
  author and submit for review. Every other workspace is org-scoped only and
  cannot publish or submit.
- A permission registry with fixed role bundles, enforced declaratively at one
  choke point rather than by ad-hoc role comparisons scattered across routes.
- No catalogue regression on deploy: entries already published stay visible.

## Non-goals

- Org-definable custom roles or a role-editor UI. Roles are fixed bundles.
- Per-resource ACL grants (permissions on an individual flow or agent).
- The integration data-capture and enrichment work. That is a separate
  sub-project with its own spec; nothing here depends on it.

---

## 1. Identity model

Three schema additions, no new identity tables.

```prisma
model Organization {
  /// 'internal' = Backstory; 'partner' = People.ai; 'customer' = everyone else.
  /// Only a platform reviewer may change this — never settable from a
  /// customer-facing route.
  kind String @default("customer")
}

model User {
  /// Platform tier, independent of the org role. null for everyone outside
  /// Backstory. 'staff' = internal employee; 'reviewer' = may decide and
  /// publish submissions.
  platformRole String?
}

enum UserRole { ADMIN  USER  OWNER  VIEWER }
```

`UserRole` gains `OWNER` and `VIEWER` rather than renaming `USER` to `MEMBER`.
`USER` remains the member tier. This avoids a data migration over every existing
row and keeps the free-text `Invitation.role` values (`'ADMIN' | 'USER'`) valid
without a backfill.

**Bootstrap.** `PLATFORM_STAFF_EMAILS` (comma-separated) is read at auth time
in `src/lib/supabase/auth-utils.ts`: a matching user whose `platformRole` is
null is promoted to `'reviewer'`, and their organization's `kind` is set to
`'internal'` if still `'customer'`. This runs only for listed addresses and is
idempotent. Once a reviewer exists, further `platformRole` and
`Organization.kind` changes happen through the admin surface (§5), gated on
`catalogue.review`. The env var stays set in production as a recovery path.

The People.ai partner org is marked `kind='partner'` by a reviewer through the
admin surface. Note this means People.ai the *company's* workspace, not People.ai
*customers* — every customer of the platform is a Sales AI customer by virtue of
the entitlement gate, and none of them gain submit rights.

## 2. Permission registry

New module `src/lib/authz/permissions.ts`. A typed permission union, fixed role
bundles, and one pure resolver:

```ts
export const PERMISSIONS = [
  'flow.read', 'flow.write', 'flow.run',
  'agent.read', 'agent.write', 'agent.run',
  'integration.manage', 'members.manage', 'org.manage', 'audit.read',
  'template.author', 'template.submit',
  'catalogue.review', 'catalogue.publish', 'catalogue.takedown',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export function resolvePermissions(
  user: { role: UserRole; platformRole: string | null },
  org: { kind: string },
): ReadonlySet<Permission>
```

Two independent axes whose results union:

**Org role bundles** (cumulative):

| Role | Adds |
| --- | --- |
| `VIEWER` | `flow.read`, `agent.read` |
| `USER` | `flow.write`, `flow.run`, `agent.write`, `agent.run`, `template.author` |
| `ADMIN` | `integration.manage`, `members.manage`, `org.manage`, `audit.read` |
| `OWNER` | (same as ADMIN today; reserved for billing/deletion as those land) |

`VIEWER` and `OWNER` become assignable wherever `ADMIN`/`USER` already are:
the `role` field on `Invitation` (validated at the API layer in
`src/app/api/invitations/accept/route.ts`) and the member-role update in
`src/app/api/organizations/members/[id]/route.ts`, both of which widen their
accepted value set. Without this the two new roles would be unreachable.

**Platform overlay** (independent of org role):

| Condition | Grants |
| --- | --- |
| `org.kind ∈ {internal, partner}` | `template.submit` |
| `user.platformRole === 'reviewer'` | `catalogue.review`, `catalogue.publish`, `catalogue.takedown` |

A customer workspace never receives `template.submit` or any `catalogue.*`
permission, regardless of org role. `platformRole === 'staff'` grants nothing on
its own today; it exists so an internal employee can be distinguished from a
reviewer in the admin member list, and so review rights can be granted and
revoked without changing the org.

`resolvePermissions` is pure and has no DB access, so the full role × org.kind
matrix is unit-testable without a database.

### Enforcement

`AuthContext` (`src/lib/server/auth.ts`) gains `permissions: ReadonlySet<Permission>`
and `can(p: Permission): boolean`, computed once in `requireAuthContext` from
the already-loaded `dbUser` and a `select`-narrowed organization read.

`withAuthenticatedApi` (`src/lib/server/api-handler.ts`) takes a new option:

```ts
withAuthenticatedApi(handler, { permission: 'flow.write' })
```

When set and unsatisfied, it throws `AuthContextError(403, 'PERMISSION_DENIED')`
before the handler runs. 89 of the 100 route files already use this wrapper, so
step 1 of the build is purely mechanical: each declares the requirement it
already enforces implicitly, with no behavior change for existing users (every
current member is `USER` or `ADMIN`, and both satisfy the permissions their
routes already allowed).

The 11 route files outside the wrapper are unauthenticated or
alternately-authenticated by design and are **not** migrated:
`cron/retention`, `cron/dispatch`, `invitations/lookup`, `health`,
`peopleai/callback`, `mcp-connections/oauth/callback`, `flows/[id]/trigger`,
`flows/[id]/runs/[runId]/resume`, `signals/people-ai`, `nango/webhook`,
`agents/[id]/trigger`. Each gets a one-line comment recording why it is exempt,
and a test asserts the exemption list does not grow silently.

Client-side, `useAuth()` exposes the permission set so affordances can be hidden.
This is cosmetic only — the server remains the boundary, and every gated route
is tested for the 403 independently of the UI.

## 3. Submission and publishing

### The submission record

```prisma
/// An author's request to publish an artifact to the shared catalogue.
/// `snapshot` is FROZEN at submit time: it is what gets reviewed and what gets
/// published, so edits the author makes afterward cannot leak into a published
/// entry without a fresh submission.
model CatalogueSubmission {
  id                String    @id @default(cuid())
  /// 'flow_template' | 'agent_template' | 'shared_skill'
  kind              String
  /// 'pending' | 'changes_requested' | 'approved' | 'rejected' | 'withdrawn'
  status            String    @default("pending")
  title             String
  summary           String    @db.Text
  snapshot          Json
  /// The author's own row this was snapshotted from. Informational — the
  /// snapshot is authoritative, and the source may be edited or deleted.
  sourceId          String?
  organizationId    String    @db.Uuid
  submittedByUserId String
  reviewerUserId    String?
  reviewNote        String?   @db.Text
  decidedAt         DateTime?
  /// The published row created on approve (§3, publish target).
  publishedEntryId  String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([status, createdAt])
  @@index([organizationId, status])
  @@map("catalogue_submissions")
}
```

`organizationId` is the *submitting* org, which makes the row org-scoped, so
`CatalogueSubmission` is added to `ORG_SCOPED_MODELS` in
`src/lib/tenant-guard.ts` alongside the other org-carrying models. The
reviewer's cross-org queue read is one explicit `systemPrisma` call with a
justification comment, matching the existing pattern in
`src/lib/templates/catalogue.ts:91`.

### Publish target

Approving writes the snapshot into the **existing artifact tables**, owned by
the Backstory internal org, with `visibility='global'`. No `CatalogueEntry`
table is introduced. `AgentTemplate.userId` and `FlowTemplate.userId` are
required, so the published row records the **approving reviewer** as its user —
the person accountable for the entry, not the outside author. Author attribution
for display lives in the existing `configuration.authorName` field, carried over
from the snapshot. This is the decisive simplification: `fetchCatalogueRows`,
the flow-template read paths, `instantiate.ts`, and the skill composer all keep
working untouched, and a published entry is an ordinary template that staff can
edit like any other.

Takedown sets `isActive=false`, which every read path already filters on.

`SharedSkill` gains `visibility String @default("org")` so it stops being
public-by-construction, and `GET /api/skills` filters the cross-org slice to
`visibility: 'global'` — mirroring `fetchCatalogueRows`, with the caller's own
org rows read through the tenant-guarded client.

### Grandfathering

All three artifact tables gain:

```prisma
/// 'none' | 'legacy_published' | 'published'
catalogueStatus String @default("none")
```

The migration backfills existing rows: every `visibility='global'`
`AgentTemplate`/`FlowTemplate`, and every `SharedSkill` (all of which are
effectively published today), becomes `catalogueStatus='legacy_published'`, with
`SharedSkill.visibility` set to `'global'` in the same statement. Nothing
disappears from the catalogue on deploy. Staff get a Legacy tab (§5) listing
exactly these rows for audit and retirement.

`visibility` says whether a row is in the catalogue; `catalogueStatus`
distinguishes reviewed from grandfathered.

## 4. Closing the publish hole

`visibility` is removed from every client-writable Zod schema —
`src/app/api/flow-templates/route.ts:25` and the `PATCH` passthrough at
`route.ts:82` are the live instances. It becomes server-controlled: `'org'` on
create, and only the publish path (a reviewer acting on an approved submission)
ever writes `'global'`.

A test walks the create/update route modules and asserts none accepts
`visibility` from a request body, so this specific regression cannot recur.

This step is independently shippable and closes the security gap before any
submission UI exists.

## 5. Surfaces

### `/admin/catalogue` — staff only

A route group gated on `catalogue.review` in both `src/middleware.ts` and the
layout, so it is invisible and unreachable from a customer workspace.

- **Queue** — pending submissions: kind, title, submitting org, author, age.
- **Detail** — the snapshot rendered with the existing template preview
  component (flow graph preview for `flow_template`), plus a diff against the
  currently published entry when this is a re-submission.
- **Decisions** — Approve & publish, Request changes (note required), Reject
  (reason required). Each writes an `AuditEvent` via `recordAudit` with
  `action: 'catalogue.approved' | 'catalogue.changes_requested' |
  'catalogue.rejected' | 'catalogue.takedown'`.
- **Published** — live catalogue entries with takedown.
- **Legacy** — grandfathered rows needing audit; retire or mark reviewed.
- **Members** — grant/revoke `platformRole`, set `Organization.kind`.

### Author side

A "Submit to catalogue" affordance rendered only when `template.submit` is held,
on flow templates, agent templates, and shared skills. Customer workspaces see
only the existing workspace-sharing controls, and the submission API returns
403 `PERMISSION_DENIED` if the call is crafted directly.

Submission status surfaces on the author's own artifact card: pending, changes
requested (with the reviewer's note), published, or rejected. Re-submitting
after changes creates a new submission row referencing the same `sourceId`.

`notify()` carries `catalogue.submitted` to reviewers and `catalogue.decision`
to the submitter, reusing the existing notification and push plumbing.

## 6. Error handling

- Unsatisfied permission → 403 `PERMISSION_DENIED` from the wrapper, with the
  required permission in `detail` for debuggability. Never a 404: hiding the
  route's existence is not a goal here and complicates client handling.
- Submitting without `template.submit` → 403, same code.
- Approving a submission whose `sourceId` row was deleted → succeeds. The
  snapshot is authoritative; source deletion is expected and not an error.
- Approving an already-decided submission → 409 `ALREADY_DECIDED`, so two
  reviewers acting concurrently cannot double-publish. The decision is written
  with a conditional update on `status='pending'`.
- Publishing when the internal org cannot be resolved (`kind='internal'` unset)
  → 500 with an explicit message pointing at `PLATFORM_STAFF_EMAILS`. This is a
  misconfiguration, not a user error, and should be loud.

## 7. Testing

- **Unit** — `resolvePermissions` over the full role × `org.kind` ×
  `platformRole` matrix, including the negative cases that matter most: a
  customer `ADMIN` holds neither `template.submit` nor any `catalogue.*`
  permission, and a partner `USER` holds `template.submit` but not
  `catalogue.review`.
- **Route** — via `setTestAuthContext`: customer org 403s on submit; partner org
  submits but 403s on review; reviewer publishes; a body-supplied
  `visibility: 'global'` on template create/update is ignored; a second approve
  of the same submission 409s.
- **DB** — mirroring `src/app/api/flow-templates/__tests__/scoping.db.test.ts`:
  published entries are readable cross-org, `catalogueStatus='none'` rows are
  not, and the same for shared skills once `visibility` gates them.
- **Migration** — assertion that existing global templates and all existing
  shared skills land on `legacy_published` and stay readable.

New tables carry RLS policies consistent with the jam work in `supabase/`, so
Postgres enforces the org boundary independently of the Prisma guard.

## 8. Build sequence

1. Permission registry, resolver, `AuthContext` wiring, and per-route
   declarations. No behavior change; exemption list recorded and tested.
2. Schema migration: `Organization.kind`, `User.platformRole`, `UserRole`
   additions, `SharedSkill.visibility`, `catalogueStatus` on three tables,
   `CatalogueSubmission`, RLS policies, legacy backfill.
3. Close the publish hole: server-controlled `visibility` on all template routes
   and the skills route.
4. Submission API and author-side UI.
5. `/admin/catalogue` review surface, publish, and takedown.
6. Legacy audit tooling and the member/org-kind management tab.

Steps 1–3 are independently shippable and close the security gap before any new
UI exists.

## Follow-on

Sub-project B — hardening the external integration data-capture layer so tool
results are entity-resolved into the graph-RAG store and pushed back to
People.ai Sales AI — is specified separately. It shares no data model with this
work; the only overlap is that capture consent will be gated on a permission
from the registry built here.
