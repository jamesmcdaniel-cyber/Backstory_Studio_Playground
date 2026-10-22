# Platform audit, 2026-10-22

Prompted by an `@artifact` failure on 2026-10-21: an ROI Analyst run failed with "@artifact was requested, but the agent did not produce an executable artifact". That was fixed in b2aa7762, and Fly worker v87/v88 carry the fix. The audit looked for other failures in the same family: features that break with no code change, because a check misreads its input, a dependency fails in a way the code mistakes for user error, or monitoring stopped without anyone noticing.

Scope:
- the local gates and CI on main;
- production health, logs and env-var names (read-only);
- the artifact pipeline;
- agent execution and the queue plane;
- the code shipped since 2026-10-08;
- configuration and dependency drift.

## What was silently broken

| Finding | Effect | Fix |
|---|---|---|
| CI's `check` job ran `npm audit` as its first step. A new follow-redirects advisory failed it. | Typecheck, tests, worker smoke and build were skipped on every push to main. | 92548534: audits run last (`if: !cancelled()`); follow-redirects 1.16.1 |
| `templates.db.test.ts` still asserted that a personal copy's owner cannot share. 49b8c317 made that allowed on purpose. | The `rls` job was red on every push. The local gate never runs DB tests, so nobody saw it. | 92548534 |
| Health-monitor, eval-nightly and backup-restore-proof are guarded on `github.repository == 'jamesmcdaniel-cyber/Backstory_Studio'`. The repo is now `Backstory_Studio_Playground`. | All three skip every run. Nothing monitors uptime. | **Open:** the change touches shared workflows, so it needs an owner's approval (below) |
| The artifact validator reported its own failures (45 s deadline, Chromium crash, body cap, UID reuse) as 422 content verdicts. | Agents "fixed" healthy pages, and the run then failed, after its email or Slack post had already gone out. | b053e2ab, 6d5c0ae1 |
| `looksLikeHtml` counted any `<p>`/`<table>` pair as a page. | A Markdown answer quoting an HTML snippet set off a ~7.5-minute Opus render, and flow steps, Slack and email received app source. | 60d40306 |
| The declared-tests rule applied to uploads and CSS files. | Normal HTML uploads failed, every CSS upload failed, and the user saw a bare 500. | 1f5cd7b9 |
| The `@artifact` gate ran before blocker and guardrail handling, and external text (Slack, email, webhooks) could switch it on. | It hid real outcomes such as "Not delivered — Gmail not connected" and skipped refusal audits. | 3ea8c5dc |
| The agent reaper failed any run 30 minutes after it started. | Healthy long runs (a 28-minute turn, or an artifact render) showed "exceeded time limit" and later flipped to completed. | ddcf9ac0 (`lastActiveAt` heartbeat) |
| Agent dead-lettering ran on every attempt and for deterministic refusals, with no status guard. | Duplicate parks and alerts, and a losing reply could overwrite a running execution to failed. | b8a24a83 |
| No `kill_timeout` on the Fly worker. | Every deploy killed in-flight runs after 5 s. | ff24bc5a |
| The worker's schedule registrar ignored `quarantinedAt`. | A deprovisioned owner's agents kept firing as the org's oldest member. | d5406163 |
| `roi_load_extract` followed redirects with a saved credential attached. | A bearer, basic or API-key credential could reach another host. | 1c534c51 |
| Pricing table. | Haiku 5.5 was costed 10x high, Sonnet 5 1.5x high, and Opus 5.5 and Fable 5.1 cache reads were wrong. | 5d390649 |
| `@prisma/client` 6.14 ran with the 6.19 CLI. | A known source of runtime failures. | 0fb0aff3 |
| next 15.5.27 and @sentry/nextjs 10.63 (advisories published during the audit). | Critical: unauthenticated RCE through the Image Optimization API with SVG, a Server Actions DoS, and a Sentry tunnel middleware bypass. | ec8561a8: next 15.5.28, @sentry/nextjs 10.76 |

Also fixed: model streams with no end-to-end deadline (e9a7f272); a chat run badge stuck on "running" in queue mode (a079bb94); a slow first state load making a page read-only (f0d72185); the artifact chat spinning on deleted or awaiting-approval runs (2e0d19d7); onclick-only pages with dead buttons (8a205707).

## Shipped alongside: requested features

- Per-tool permissions for MCP servers. These are Always allow, Needs approval and Blocked, enforced for agents, flows and copilots. A connected server card opens the detail view (141760b8 and predecessors).
- Databricks and Snowflake for flows and agents, with the n8n import mapping (the commits from the generic Databricks client through a2d97063). Snowflake gains key-pair and access-token credential types. See docs/warehouse-connectors.md.

## Verification

Each merge passed typecheck, lint, the migration drift check, and the full CI-mode suite on a fresh database (Postgres + Redis). The last run before this document: 5,129 pass, 0 fail, 7 skipped, plus a clean `next build`. GitHub CI on main is green again from ec8561a8 (check, rls, migrations). Browser E2E's authenticated journeys still fail at their secrets check: the E2E_* repository secrets are not set. Production `/api/health` is ok after each deploy.

## Needs an owner

**Deploys:**
- Fly worker: `fly deploy -c fly.worker.toml`. The run-queue, artifact, MCP-permission and warehouse changes run there, and so does the new `kill_timeout`.
- Artifact validator (`fly.artifact-validator.toml`), for the 503 infra replies, the upload exemption and the 64 MiB body cap. Its 1 GB VM is sized for typical pages. Watch memory if very large ROI pages get validated.

**Workflows:** in `health-monitor.yml`, `eval-nightly.yml` and `backup-restore-proof.yml`, change the guard to `github.repository != 'jamesmcdaniel-cyber/Backstory_customers'`. Then set the `HEALTH_MONITOR_URL` secret.

**Env vars (names only were checked):**
- `NANGO_API_KEY` and `NANGO_WEBHOOK_SIGNING_KEY` are missing from Vercel and Fly; Nango still runs on the deprecated `NANGO_SECRET_KEY`.
- `SENTRY_DSN` is unset everywhere.
- Also unset: `HEALTH_DETAIL_TOKEN`, `RESEND_API_KEY`, and the VAPID keys.
- `.env.worker.prod` is a stale pull containing nine `[SENSITIVE]` placeholders. Never import it into Fly.

**Not fixed:** Pyodide runs on the worker's main thread (`code-runner.ts`), and a 5-minute dataset step blocks the heartbeat and the other slots. The agent job lock was sized (8 minutes) to survive it. Moving Python to a worker thread is the real fix.
