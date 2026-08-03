# Customer edition runbook

`Backstory_customers` is a mirror of `Backstory_Studio` whose only permanent
diff is `src/lib/edition.config.ts`. Everything else about running it — schema,
migrations, worker, crons — is identical.

## Syncing upstream features into Backstory_customers

```bash
cd /Users/james.mcdaniel/Backstory_customers
git fetch upstream
git merge upstream/main
npm test
git push origin main
```

Upstream never edits `edition.config.ts`, so this merge does not conflict. If it
ever does, keep the fork's `EDITION = 'customer'` line and take upstream's
version of everything else.

## What the customer edition turns off

| Surface | Mechanism |
|---|---|
| `/admin/*` pages (catalogue, costs, domains) | 404 at the edge (`middleware.ts`) + `notFound()` in `admin/layout.tsx` |
| 13 API handlers across 10 routes | `internalOnly: true` → 404 before auth |
| AI template generation | Guards inside `maybeGenerateOnGateClear` / `sweepTemplateGeneration`; the `TEMPLATE_GENERATION` worker queue is not registered |
| Proposal UI | `ProposalsProvider` never fetches; every consumer already renders nothing for an empty list |
| Onboarding step 2 | Two-stage stepper; entitlement is the only gate |
| Staff bootstrap | `applyStaffBootstrap` is a hard no-op regardless of `PLATFORM_STAFF_EMAILS` |

Metering is **not** gated. Token recording, monthly quota enforcement, the
rate limiter and the runaway-agent caps run in every edition. Usage and spend
UI visible to a workspace's own admins is also unchanged — only the
cross-workspace operator views are gated.

## Verifying the gates on the customer deploy

After any deploy, confirm these return 404 while signed in as a workspace admin:

- `/admin/catalogue`, `/admin/costs`, `/admin/domains`
- `/api/admin/costs`, `/api/admin/domains`
- `/api/catalogue/staff`, `/api/catalogue/review`
- `/api/template-proposals`

And confirm onboarding forwards: a fully-entitled workspace landing on `/connect`
must reach `/dashboard` without needing three integrations connected. A hang on
the stepper means the proposals fetch was reintroduced without updating
`shouldForwardToDashboard`.

## Deployment differences

Separate Vercel project, separate database, separate Supabase project. Leave
`PLATFORM_STAFF_EMAILS` unset — belt and braces alongside the code-level no-op.
Cron entries in `vercel.json` are identical; the generation sweep returns `[]`
on its own, so `generatedOrgs` is simply always empty in the cron response.

## Adding a new internal-only surface

1. Gate the route: `withAuthenticatedApi(handler, { permission, internalOnly: true })`.
2. Add its path to `INTERNAL_ONLY_ROUTES` in `src/app/api/__tests__/edition-gates.test.ts`
   and a 404 case alongside it.
3. For a page, add its prefix to `CUSTOMER_BLOCKED_PREFIXES` in `src/lib/edition.ts`.

Step 2 is enforced: a completeness test fails the build if the gated set on disk
drifts from the inventory, in either direction.
