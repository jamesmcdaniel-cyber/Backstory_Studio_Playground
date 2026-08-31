# Nango integration setup

Nango is the **single** integration provider for Backstory Studio (it replaced
Klavis). It does two things:

- **OAuth storage** — users connect their accounts through the in-app Nango
  Connect UI; Nango holds the credentials (they never touch our servers).
- **Tool proxy** — agent tools call provider REST/GraphQL APIs through Nango's
  proxy using the stored connection.

## How the pieces link (important)

There are two catalogs and they are joined by **one string**: the Nango
integration's `unique_key`.

| Layer | Source of truth | File |
|---|---|---|
| Which apps appear in the UI to connect | Your **Nango dashboard** (`listIntegrations()`) | `src/app/api/nango/integrations/route.ts` |
| Which apps have **agent tools** | Code registry `PROVIDER_CONFIG_KEYS` | `src/lib/nango/provider-config-keys.ts` |

An integration's `unique_key` in the dashboard **must exactly equal** one of the
config keys below, or a user can connect the account but **no agent tool will
ever resolve it**. The integrations grid shows the live agent-tool count per
card ("N agent tools available", or an amber "no agent tools are wired" note) so
this mismatch is visible at a glance.

## 1. Environment variables

Set in Vercel (web) **and** the worker (Render / docker-compose):

Nango **split its old single secret into two credentials**. Environments created
after 2026-04-20 (or any that rotated) are issued a scoped **API key** and a
separate **webhook signing key**, and have no "secret key" in the dashboard at
all. Both models are supported:

| Var | Required | Notes |
|---|---|---|
| `NANGO_API_KEY` | **Yes** | Authorizes API calls. Scoped — needs at least `environment:integrations:list` and `environment:connections:list`, or the grid 403s. |
| `NANGO_WEBHOOK_SIGNING_KEY` | For webhooks | Verifies webhook HMACs. Nango **never** signs with the API key, so without this every connection event fails verification. |
| `NANGO_SECRET_KEY` | Legacy | The old single secret that did both jobs. Still honoured as a fallback for either of the two above, so existing deployments are unaffected. |
| `NANGO_HOST` | No | Self-hosted/regional API host. Blank = Nango Cloud. |
| `NEXT_PUBLIC_NANGO_CONNECT_URL` | No | Self-hosted Connect UI base URL. Blank = `https://connect.nango.dev`. |
| `NANGO_PROXY_TIMEOUT_MS` | No | Per-request proxy ceiling (ms). Default `20000`. |

Without an API key, every Nango route returns `503 NANGO_UNAVAILABLE` and the
agent tool planes are empty — integrations are effectively off.

A scoped key missing `environment:integrations:list` is the subtle failure: it
authenticates, so nothing looks misconfigured, and then 403s on the one call
that populates the grid. `npm run nango:doctor` reports Nango's own reason.

## 2. Enable these integrations in the Nango dashboard

Create each integration below with its **`unique_key` set to the canonical key**
(first column). The alternate keys are also accepted by the code if Nango
assigns a different default slug — but prefer the canonical one.

| Provider | Canonical `unique_key` | Also accepted |
|---|---|---|
| GitHub | `github` | — |
| Linear | `linear` | — |
| Jira | `jira` | `atlassian` |
| Asana | `asana` | — |
| Notion | `notion` | — |
| HubSpot | `hubspot` | — |
| Confluence | `confluence` | — |
| Zendesk | `zendesk` | — |
| Monday | `monday` | — |
| Google Drive | `google-drive` | `google_drive` |
| Google Sheets | `google-sheet` | `google-sheets`, `google_sheets` |
| Google Calendar | `google-calendar` | `google_calendar` |
| Slack | `slack` | — |
| Gmail | `google-mail` | `gmail` |
| Salesforce | `salesforce` | `salesforce-sandbox` |
| Airtable | `airtable` | — |
| Figma | `figma` | — |
| Granola | `granola` | — |

Granola is API-key auth (not OAuth): Nango's connect UI asks for the user's
Granola API token (`grn_…`) and stores it; tools proxy with it like any OAuth
connection. It also has a separate built-in per-org-key plane
(`src/lib/integrations/granola.ts`) — the Nango plane serves accounts connected
from the integrations grid.

These 18 providers are the ones with authored agent tools. The canonical list is
`PROVIDER_CONFIG_KEYS` in `src/lib/nango/provider-config-keys.ts` (re-exported
from `provider-tools.ts`; plus the delivery write tools for Slack/Gmail/
Salesforce in `src/lib/nango/delivery.ts`) — keep the dashboard and that map in
sync when adding providers. `npm run nango:doctor` checks the dashboard against
that map for you and imports it directly, so it cannot drift out of date.

For each integration you'll also set the OAuth app credentials (client id/secret
and scopes) in the Nango dashboard, per Nango's per-provider docs.

## 3. Configure the connection webhook

So agent runs see a freshly connected account without the user reopening the
integrations page, point Nango at our webhook:

- Nango dashboard → **Environment Settings → Webhooks**
- URL: `https://<your-app-domain>/api/nango/webhook`
- Enable connection (auth) events.

The route (`src/app/api/nango/webhook/route.ts`) verifies the signature with
`NANGO_WEBHOOK_SIGNING_KEY` (falling back to the legacy `NANGO_SECRET_KEY`) and
re-syncs that org's connection mirror. It's optional —
the mirror also refreshes whenever the integrations page loads — but recommended
for scheduled/headless runs.

## 4. Verify it works

1. Open **Integrations**. The grid lists the dashboard integrations; each card
   shows its agent-tool count. If a card shows the amber "no agent tools" note,
   its `unique_key` doesn't match a config key above — fix the dashboard slug.
2. Click **Connect** on one (e.g. Slack) and finish the OAuth flow. The card
   flips to **Connected**.
3. Run an agent/flow that uses that provider's tool. It should resolve the
   connection and call the provider through Nango's proxy.

## 5. Rotating the key / rebuilding the Nango account

If the Nango account is wiped, re-created, or the integrations are rebuilt under
a **new secret key**, the app does not need a code change — but three pieces of
state outlive the old account and have to be dealt with.

**1. Point the deployments at the new key.** Set `NANGO_API_KEY` and
`NANGO_WEBHOOK_SIGNING_KEY` in Vercel (all environments that should use it)
**and** on the worker (Fly/Render/docker-compose). The worker resolves connections independently, so a worker left
on the old key keeps failing every tool call after the web app is fixed. The
worker needs a redeploy to pick it up.

Verify the new key against the new environment before trusting it — no need to
put it in `.env.local` first:

```bash
npm run nango:doctor -- --key=<new secret key>
```

It authenticates, lists the integrations enabled in that environment, and flags
any whose `unique_key` doesn't match the code registry. Add `--host=` for a
non-US-Cloud region (`https://api-eu.nango.dev`).

**2. Re-create the integrations with the canonical `unique_key`s** (§2). This is
the step that silently breaks a rebuild: Nango's default slug for a newly-added
integration is not always what the old one used, and an integration keyed
`slack-prod` instead of `slack` is connectable but resolves **zero agent tools**.
The doctor names every mismatch. Each integration also needs its OAuth app
credentials re-entered — those did not survive either.

**3. Re-add the webhook** (§3). Webhook config belongs to the Nango environment,
so a rebuilt account has none, and it is signed with the *new* secret key.

### What happens to connections users had already made

They are gone — Nango held the credentials, so every user has to reconnect. Our
`nango_connections` mirror still holds the dead connection ids, and the two
readers of that mirror behave differently:

- The **integrations page** renders the live Nango listing, so it immediately and
  correctly shows nothing connected.
- The **agent runtime** (`resolveNangoConnection`) reads the mirror.

`syncOrgNangoConnections` deliberately does not delete mirror rows when Nango
returns an empty list (a transient empty would otherwise disconnect a healthy
workspace). Instead it **demotes** them to `status: 'error'` with a reconnect
message, which is what makes the runtime agree with the page: agents stop
resolving dead connection ids and report "connect your account" rather than
failing deep inside the provider proxy. The demotion is self-healing — the next
non-empty sync restores those rows to `connected`.

The demotion happens per organization, the first time anything syncs that org
(an integrations page view, or a webhook). Nothing global needs to be run.

The enabled-integrations list is cached for 10 minutes
(`nango:integrations`, Redis in production), so the grid can show the old
catalog briefly after a rebuild. It expires on its own.
