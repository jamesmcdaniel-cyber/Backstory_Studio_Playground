import { EMBED_COMPLETE_PATH } from '@/lib/embed'

/**
 * The two OAuth hand-offs onboarding makes — Sales AI entitlement and the
 * Backstory MCP connection — and where each one comes back to.
 *
 * Both are real redirects to an identity provider, which is why the frame
 * cannot run them: the provider refuses to render framed, and the flow's
 * SameSite=Lax state cookie is never stored in a third-party context, so the
 * callback finds no state and bounces onboarding back to step 1. Embedded, the
 * same URLs are opened in a popup and told to come back to the landing page
 * that notifies the frame instead of to /connect, which nobody would ever see.
 */
export function connectReturnPath(embedded: boolean): string {
  return embedded ? EMBED_COMPLETE_PATH : '/connect'
}

export function entitlementConnectHref(returnTo: string): string {
  return `/api/peopleai/connect?return_to=${encodeURIComponent(returnTo)}`
}

export function mcpConnectHref(connectionId: string | null, returnTo: string): string {
  const params = new URLSearchParams({ connectionId: connectionId ?? '', returnTo })
  return `/api/mcp-connections/oauth/start?${params.toString()}`
}
