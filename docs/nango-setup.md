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
| Which apps have **agent tools** | Code registry `PROVIDER_CONFIG_KEYS` | `src/lib/nango/provider-tools.ts` |

An integration's `unique_key` in the dashboard **must exactly equal** one of the
config keys below, or a user can connect the account but **no agent tool will
ever resolve it**. The integrations grid shows the live agent-tool count per
card ("N agent tools available", or an amber "no agent tools are wired" note) so
this mismatch is visible at a glance.

## 1. Environment variables

Set in Vercel (web) **and** the worker (Render / docker-compose):

| Var | Required | Notes |
|---|---|---|
| `NANGO_SECRET_KEY` | **Yes** | Environment secret key (Nango dashboard → Environment Settings). Also verifies the webhook signature. |
| `NANGO_HOST` | No | Self-hosted/regional API host. Blank = Nango Cloud. |
| `NEXT_PUBLIC_NANGO_CONNECT_URL` | No | Self-hosted Connect UI base URL. Blank = `https://connect.nango.dev`. |
| `NANGO_PROXY_TIMEOUT_MS` | No | Per-request proxy ceiling (ms). Default `20000`. |

Without `NANGO_SECRET_KEY`, every Nango route returns `503 NANGO_UNAVAILABLE`
and the agent tool planes are empty — integrations are effectively off.

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

These 17 providers are the ones with authored agent tools. The canonical list is
`PROVIDER_CONFIG_KEYS` in `src/lib/nango/provider-tools.ts` (plus the delivery
write tools for Slack/Gmail/Salesforce in `src/lib/nango/delivery.ts`) — keep the
dashboard and that map in sync when adding providers.

For each integration you'll also set the OAuth app credentials (client id/secret
and scopes) in the Nango dashboard, per Nango's per-provider docs.

## 3. Configure the connection webhook

So agent runs see a freshly connected account without the user reopening the
integrations page, point Nango at our webhook:

- Nango dashboard → **Environment Settings → Webhooks**
- URL: `https://<your-app-domain>/api/nango/webhook`
- Enable connection (auth) events.

The route (`src/app/api/nango/webhook/route.ts`) verifies the signature with
`NANGO_SECRET_KEY` and re-syncs that org's connection mirror. It's optional —
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
