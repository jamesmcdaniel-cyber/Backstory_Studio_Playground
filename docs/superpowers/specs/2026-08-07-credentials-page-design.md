# Credentials page — dedicated management surface

**Date:** 2026-08-07
**Status:** Approved (standing autonomous-execution mandate; built same day)

## Problem

The credentials bank lives as a collapsible card inside `/flows`. It is mostly
read-only: OAuth accounts, MCP servers, and workspace keys all link out to other
pages, and only HTTP credentials are actionable. There is no single place to
manage expired credentials, and no way to rotate an exposed or leaked credential
without hunting across three pages.

## Goal

A dedicated `/credentials` page — reachable from a **Credentials** button next
to Import / New flow on the Flows page and from the sidebar — where every
credential type in the workspace is fully manageable:

- **See health at a glance**: connected / needs-attention counts, per-row status.
- **Fix expired credentials in place**: verify, reconnect, re-verify.
- **Rotate exposed or leaked credentials** from the same page.

## Design

### Route & navigation

- `src/app/credentials/page.tsx` (client component), rendered in the app shell.
  Root element is `<div className="space-y-6">` per the layout contract.
- Sidebar nav gains `Credentials` (KeyRound icon) after Integrations.
- `APP_PREFIXES` in `app-shell.tsx` and `SHELL_PREFIXES` in
  `layout-contract.test.ts` gain `/credentials`.
- Command palette NAV list gains Credentials.
- Flows page: the inline `<CredentialsBank />` collapsible is removed; a
  `Credentials` outline button (KeyRound) sits beside Import / New flow and
  links to `/credentials`. `credentials-bank.tsx` is deleted (it was used only
  there); its section/row primitives move into the new page.

### Page structure (one page, four sections — no tabs, so nothing hides)

Header: `PageHeader` (eyebrow "Workspace", title "Credentials") + live summary
badges (`N connected`, `M need attention`) + a Refresh button. Data comes from
the same four read surfaces the bank used: `/api/nango/status`,
`/api/nango/integrations` (catalog names/logos for connect), `/api/mcp-connections`,
`/api/http-credentials`, `/api/integrations/credentials/{slack,email,granola}`.

1. **App accounts (OAuth via Nango)** — one row per connected config key with
   status badge (Verified / Unverified / Reconnect needed) and inline actions:
   - **Verify** — `POST /api/nango/connections/:id/verify` (existing).
   - **Reconnect** — reopens the Nango Connect UI over the existing connection
     (existing `useNangoConnect.connect`); fixes expired/revoked tokens.
   - **Rotate** — for exposed/leaked tokens: confirm dialog, then
     `DELETE /api/nango/connections/:id` (revokes stored tokens) followed
     immediately by the connect flow so fresh tokens are issued.
   - **Disconnect** — confirm dialog + DELETE (replaces the hook's
     `window.confirm` on this page).
   - "Connect new" links to `/integrations` (the searchable catalog stays there).
2. **HTTP credentials** — existing create / re-verify / delete, plus **Rotate**:
   opens `HttpCredentialDialog` in rotate mode (same id, name and auth type
   prefilled, secrets re-entered fresh, live-verified before store). Server
   support already exists — `POST /api/http-credentials` with `id` replaces the
   secret after `verifyCredentialLive`.
3. **MCP servers** — status rows (active/inactive, host, personal/org scope)
   plus a link to the full management UI at `/integrations?tab=servers`
   (discover/test flows are not duplicated).
4. **Workspace keys** — `WorkspaceCredentialsPanel` rendered inline: connect,
   **Replace** (= rotate), remove. The autofill guard test only forbids the
   panel on `/integrations` (search-input pairing bug); this page has no search
   input.

### Permissions

All list endpoints are `flow.read`; every mutation is `integration.manage`
(ADMIN+). The page is visible to all members; write actions are hidden behind
`useAuth().can('integration.manage')` with a note that only workspace admins
manage credentials — instead of the bank's show-then-403 pattern.

### No new API routes

Everything needed exists. No route-smoke test changes.

### Tests

- `layout-contract.test.ts`: add `credentials` to `SHELL_PREFIXES`.
- `credential-surface.test.ts`: new guards — the Flows page links to
  `/credentials`; the credentials page renders `WorkspaceCredentialsPanel`
  and carries no bare-text search input.

## Alternatives considered

- **Tabbed page (like /integrations)** — rejected: four small sections on one
  page keeps the "everything from one page" promise; tabs hide attention state.
- **Keep the inline bank AND add the page** — rejected: two management surfaces
  drift; the Flows header button keeps the one-click path.
- **Health badge on the Flows button** — rejected for now: it would re-add the
  four status fetches (incl. a Nango API round-trip) to every Flows visit; the
  collapsed bank showed no counts either.
