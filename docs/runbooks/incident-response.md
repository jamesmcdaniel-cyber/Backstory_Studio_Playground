# Incident response runbook

## Severity definitions

Severities are graded by user-visible impact, not by root-cause complexity —
a one-line config typo and a subtle race condition can both be SEV1 if they
take production down.

### SEV1 — production down or data-integrity risk for all/most tenants

All-hands, drop everything. Examples from this platform's real history:

- **2026-07-10 tenant guard 500s** — a missing `organizationId` filter on a
  guarded model call site threw in production, taking down the affected
  routes platform-wide. Resolved with an emergency guard sweep across all 190
  guarded-model call sites (documented in `.superpowers/sdd/progress.md`
  around the "INCIDENT 2026-07-10" entry).
- **The RLS rollout outages (culminating ~2026-08-09)** — enabling row-level
  security for every org-scoped model at once moved every query onto the
  transaction path simultaneously; against a pgbouncer transaction pooler at
  `connection_limit=1` that exhausted connections. Three separate outages
  before the rollout was reverted to a staged, per-model flag
  (`DATABASE_RLS_ENABLED`, see `docs/runbooks/security-controls.md` §3). A
  fourth near-miss (`systemPrisma` silently falling back to the non-owner
  `DATABASE_URL`) is now a boot-time refusal in `src/lib/prisma.ts`.
- **2026-08-04 queue-without-consumer outage** — `EXECUTION_MODE=queue` with
  no registered BullMQ consumer (or a consumer on a different Redis instance
  than the producer) accepted every flow/agent run into `waiting`, where it
  hung indefinitely while `/api/health` reported healthy the whole time. See
  `docs/runbooks/queue-incident.md` §2.
- **2026-08-14 owner MFA lockout** — a permission-check regression returned a
  blanket 403 (`MFA_REQUIRED`) for the privileged owner account across
  production, blocking the one operator role that can act on incidents.

### SEV2 — a major feature or a subset of tenants degraded

Fix within the same working session; page if it's spreading. Examples:
a single integration's tool calls failing platform-wide (Nango/People.ai
outage), the DLQ backlog climbing for one workflow shape while everything
else runs fine, a stale worker heartbeat with runs queuing but not yet
timing out.

### SEV3 — cosmetic, isolated, or has a workaround

Normal backlog priority. Examples: a UI overflow bug, a single customer's
misconfigured webhook, a non-critical dependency (Neo4j RAG) degrading to
its documented no-op fallback.

## Escalation / on-call

**There is no multi-person rotation.** This is a single-operator platform:
the **Platform Owner** role (the two hardcoded owner accounts — see the
"Platform owner invariant" convention; the owner identity is immutable at the
DB trigger level, not assignable) is the only privileged account and the de
facto on-call. Do not build tooling or docs that assume a paging rotation,
a shared on-call calendar, or a second responder — none of that exists here.
If the Owner account itself is locked out (as in the 2026-08-14 incident),
that is automatically SEV1: there is no other privileged path to fix it.

Detection is `.github/workflows/health-monitor.yml` (polls `/api/health`
every 10 minutes, opens/updates a pinned "Production health check failing"
issue on failure, closes it on recovery) plus Sentry (`SENTRY_DSN`) for
unhandled exceptions. There is no external paging service wired up; the
issue and Sentry alert land wherever the Owner is watching GitHub/email.

## Postmortem template

Copy this into a new file under `docs/postmortems/YYYY-MM-DD-short-name.md`
(or a GitHub issue) after any SEV1/SEV2:

```markdown
# Postmortem: <short title>

- **Date/time (UTC):** start – end
- **Severity:** SEV1 / SEV2
- **Detected by:** health-monitor issue / Sentry / user report / manual
- **User impact:** who/what was affected, for how long

## Timeline

- HH:MM — event
- HH:MM — event

## Root cause

What actually broke, traced to the specific code/config, not just symptoms.

## What worked

Detection/mitigation that functioned as designed.

## What didn't

Gaps: missing alert, slow detection, unclear runbook step, etc.

## Follow-ups

- [ ] Fix (owner, link to commit/PR)
- [ ] Regression test / guard added
- [ ] Runbook or doc updated
```

Keep it factual and blameless — the point is closing the gap the incident
revealed, matching the pattern already used for the tenant-guard and queue
incidents (regression tests + boot-time guards added after each one, not
just a fix).

## RPO / RTO

Derived from what is actually measured, not aspirational targets:

- **Backup cadence**: `.github/workflows/backup-restore-proof.yml` runs
  `npm run backup:create` (`scripts/backup/create.mjs`, a `pg_dump --format
  =custom` against `SYSTEM_DATABASE_URL`/`BACKUP_SOURCE_DATABASE_URL`) on a
  weekly schedule (`cron: '17 7 * * 1'`, plus manual `workflow_dispatch`).
  **RPO = 7 days** on this repo's own backup/restore-proof cadence. If
  Supabase's managed point-in-time recovery is also relied on in production,
  that provides a tighter RPO than this — but this repo has no code that
  reads or asserts Supabase's PITR configuration, so it is not counted here.
  Confirm the Supabase project's PITR/backup retention setting directly in
  the Supabase dashboard if a tighter number is needed.
- **RTO**: the workflow proves `backup:create` → `backup:verify`
  (`scripts/backup/restore.mjs` + a post-restore integrity check counting
  `organizations`/`users`/`flows` rows and failed migrations) succeeds
  end-to-end, but it does not record or assert an elapsed-time budget for the
  restore step itself — only pass/fail. **RTO is therefore unmeasured**,
  bounded in practice by however long that GitHub Actions job takes (check
  the workflow run duration in the Actions tab for the latest
  `Backup Restore Proof` run as a rough proxy) plus DNS/env cutover time this
  repo does not automate.

**Declared 2026-08-18. Revisit when the backup cadence, target, or restore
automation changes** — these are read directly off the current schedule and
scripts, not independently verified against a real production restore drill.

## Related

- `docs/runbooks/queue-incident.md` — queue-plane triage.
- `docs/runbooks/security-controls.md` — control-specific procedures (CSP,
  encryption rotation, RLS, PostgREST, bot protection, attack alerting,
  health-endpoint auth).
- `docs/runbooks/key-rotation.md` — encryption key rotation procedure.
