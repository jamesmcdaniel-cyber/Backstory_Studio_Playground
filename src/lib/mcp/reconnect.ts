/**
 * Which MCP connections are re-established by signing in, and where that goes.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * The MCP servers list used to decide this from `provider` — the slug marking a
 * server the platform manages. Only those rows got a re-authorize link. Every
 * server a person added themselves, including one connected through the very
 * same OAuth redirect, got Verify · Edit · Delete instead.
 *
 * So when such a connection's access expired there was no way back. Verify
 * reported a failure, Edit opened a form whose credential fields are blank by
 * design, and the reasonable move left was to add the server over again from
 * scratch — re-typing a URL already stored on the row we were looking at.
 *
 * `provider` answers "who manages this server". The list needed the answer to
 * "how is this connection re-established", which is a question about the AUTH
 * FLOW, and the two only overlapped by accident.
 *
 * Pure, so the answer can be pinned without mounting a page.
 */

export type ReconnectableConnection = {
  id: string
  /** Platform-managed slug; null for a server someone added. */
  provider?: string | null
  auth: { authType: string; flow?: 'authcode' }
}

/**
 * Is signing in again the way to re-establish this connection?
 *
 * True for the authorization-code flow, whoever owns the row. False for a
 * static token or a client-credentials pair: there is no sign-in behind those,
 * only a stored secret, and the way to replace one is to edit it.
 */
export function needsSignIn(connection: ReconnectableConnection): boolean {
  return Boolean(connection.provider) || connection.auth.flow === 'authcode'
}

/**
 * Where the Re-connect control points.
 *
 * Only the connection id travels. The start route reads the server URL and name
 * off the row itself — it always could — so re-connecting an expired server
 * asks for nothing that is already stored. `returnTo` is where the redirect
 * chain lands back, and must be the page holding the control.
 */
export function reconnectHref(connection: ReconnectableConnection, returnTo: string): string {
  const params = new URLSearchParams({ connectionId: connection.id, returnTo })
  return `/api/mcp-connections/oauth/start?${params.toString()}`
}
