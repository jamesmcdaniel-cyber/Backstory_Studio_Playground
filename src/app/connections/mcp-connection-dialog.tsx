'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// ── Types ────────────────────────────────────────────────────────────────────

/** How credentials are stored. Both OAuth modes below persist as 'oauth2'. */
type AuthType = 'none' | 'api_key' | 'oauth2'

/**
 * What the form offers. 'client_credentials' and 'sso' are the two oauth2
 * grants, split apart because they ask the user for completely different
 * things: a client ID + secret pair versus a sign-in redirect.
 *
 * 'api_key' is legacy — a static bearer/custom header. It is only offered when
 * editing a connection that already uses it, so existing servers stay editable
 * without inviting new ones.
 */
export type McpAuthMode = 'none' | 'client_credentials' | 'sso' | 'api_key'

export type McpConnectionDraft = {
  name: string
  description: string
  serverUrl: string
  authMode: McpAuthMode
  // legacy api_key fields
  apiKey: string
  headerName: string
  // client-credentials fields
  clientId: string
  clientSecret: string
  tokenUrl: string
  scopes: string
}

export type SerializedConnection = {
  id: string
  name: string
  description: string | null
  serverUrl: string
  isActive: boolean
  provider?: string | null
  lastVerifiedAt?: string | null
  auth: {
    authType: AuthType
    hasApiKey?: boolean
    headerName?: string
    clientId?: string
    tokenUrl?: string
    scopes?: string
    hasClientSecret?: boolean
    /** Present when the connection was established via the SSO redirect. */
    flow?: 'authcode'
  }
}

// ── Draft → wire payload ──────────────────────────────────────────────────────

/** Storage authType for a mode — the two OAuth grants share 'oauth2'. */
export function draftAuthType(mode: McpAuthMode): AuthType {
  if (mode === 'none') return 'none'
  if (mode === 'api_key') return 'api_key'
  return 'oauth2'
}

/**
 * Auth fields for POST/PUT/test bodies. Blank secrets are omitted so the server
 * preserves what it already has encrypted; 'sso' contributes no credentials at
 * all because those arrive through the redirect round-trip.
 */
export function draftAuthPayload(draft: McpConnectionDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = { authType: draftAuthType(draft.authMode) }

  if (draft.authMode === 'api_key') {
    if (draft.apiKey) payload.apiKey = draft.apiKey
    if (draft.headerName) payload.headerName = draft.headerName
  }

  if (draft.authMode === 'client_credentials') {
    // Tells the server this is the client-credentials grant, so any tokens left
    // behind by a previous SSO connect on this server are cleared.
    payload.flow = 'client_credentials'
    if (draft.clientId) payload.clientId = draft.clientId
    if (draft.clientSecret) payload.clientSecret = draft.clientSecret
    if (draft.tokenUrl) payload.tokenUrl = draft.tokenUrl
    if (draft.scopes) payload.scopes = draft.scopes
  }

  return payload
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const emptyDraft: McpConnectionDraft = {
  name: '',
  description: '',
  serverUrl: '',
  authMode: 'none',
  apiKey: '',
  headerName: '',
  clientId: '',
  clientSecret: '',
  tokenUrl: '',
  scopes: '',
}

/** Which mode an existing connection maps back to when opened for editing. */
function modeForConnection(auth: SerializedConnection['auth']): McpAuthMode {
  if (auth.authType === 'api_key') return 'api_key'
  if (auth.authType === 'oauth2') return auth.flow === 'authcode' ? 'sso' : 'client_credentials'
  return 'none'
}

// ── Test result state ─────────────────────────────────────────────────────────

type TestResult =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok'; toolCount: number; toolNames: string[] }
  | { status: 'error'; message: string }

// ── Component ─────────────────────────────────────────────────────────────────

export function McpConnectionDialog({
  open,
  onOpenChange,
  onSave,
  editingConnection,
  initialName,
<<<<<<< Updated upstream
  returnTo = '/integrations?tab=servers',
=======
>>>>>>> Stashed changes
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: McpConnectionDraft) => Promise<void>
  editingConnection?: SerializedConnection | null
  /** Pre-fills the name when adding — used when a template asks for a server by name. */
  initialName?: string
<<<<<<< Updated upstream
  /** Where the SSO redirect chain lands back — must be wherever this dialog is mounted. */
  returnTo?: string
=======
>>>>>>> Stashed changes
}) {
  const [draft, setDraft] = useState<McpConnectionDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestResult>({ status: 'idle' })
  // Set once OAuth discovery (on server-URL blur) finds an authorization
  // endpoint, so we can explain why the auth mode was auto-switched to SSO.
  const [oauthDetected, setOauthDetected] = useState(false)
  const [discovering, setDiscovering] = useState(false)

  // Populate draft when editing
  useEffect(() => {
    if (!open) return
    if (editingConnection) {
      setDraft({
        name: editingConnection.name,
        description: editingConnection.description ?? '',
        serverUrl: editingConnection.serverUrl,
        authMode: modeForConnection(editingConnection.auth),
        // Secret fields are intentionally blank on edit — server preserves
        // existing secrets when these are omitted from the PUT body.
        apiKey: '',
        headerName: editingConnection.auth.headerName ?? '',
        clientId: editingConnection.auth.clientId ?? '',
        clientSecret: '',
        tokenUrl: editingConnection.auth.tokenUrl ?? '',
        scopes: editingConnection.auth.scopes ?? '',
      })
    } else {
      setDraft({ ...emptyDraft, name: initialName ?? '' })
    }
    setTestResult({ status: 'idle' })
    setOauthDetected(false)
  }, [editingConnection, initialName, open])

  const set = (patch: Partial<McpConnectionDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }))

  // Reset test result whenever auth or URL changes
  useEffect(() => {
    setTestResult({ status: 'idle' })
  }, [draft.serverUrl, draft.authMode, draft.apiKey, draft.clientId, draft.clientSecret, draft.tokenUrl])

  // Probe the server for OAuth on blur, so leaving the default "None" auth
  // selected doesn't silently send an unauthenticated request that's bound to
  // fail. Only acts while the user hasn't already picked an auth mode
  // themselves — it won't override an explicit choice.
  const probeForOAuth = async () => {
    const url = draft.serverUrl.trim()
    if (!url || draft.authMode !== 'none') return
    try {
      void new URL(url)
    } catch {
      return
    }
    setDiscovering(true)
    try {
      const response = await fetch('/api/mcp-connections/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: url }),
      })
      const data = await response.json().catch(() => ({}))
      if (data.requiresOAuth) {
        setOauthDetected(true)
        set({ authMode: 'sso' })
      }
    } catch {
      // Inconclusive — leave the user's current selection alone.
    } finally {
      setDiscovering(false)
    }
  }

  // Client credentials need both halves of the pair. On edit, a stored secret
  // counts — the field is blank precisely so it can be left alone.
  const hasClientCredentials =
    Boolean(draft.clientId.trim()) &&
    Boolean(draft.clientSecret.trim() || editingConnection?.auth.hasClientSecret)

  // SSO (authorization-code) flow only needs a name + server URL — the rest
  // (client registration, tokens) is handled server-side after Okta login.
  const canConnectSso = Boolean(draft.name.trim() && draft.serverUrl.trim())
  // A brand-new SSO connection is created by the redirect, not by this form.
  const ssoNeedsRedirect = draft.authMode === 'sso' && !editingConnection

  const canCreate =
    Boolean(draft.name.trim() && draft.serverUrl.trim()) &&
    !ssoNeedsRedirect &&
    (draft.authMode !== 'client_credentials' || hasClientCredentials)
  const canTest =
    Boolean(draft.serverUrl.trim()) &&
    (draft.authMode !== 'client_credentials' || hasClientCredentials)

  // Full-page navigation so the browser follows the OAuth redirect chain
  // (our /start route → Okta → /callback → back to the MCP servers tab).
  const connectWithSso = () => {
    if (!canConnectSso) return
    const params = new URLSearchParams({
      serverUrl: draft.serverUrl.trim(),
      name: draft.name.trim(),
      returnTo,
    })
    if (editingConnection) params.set('connectionId', editingConnection.id)
    window.location.href = `/api/mcp-connections/oauth/start?${params.toString()}`
  }

  const testConnection = async () => {
    setTestResult({ status: 'testing' })
    try {
      // The test endpoint gets plaintext credentials and persists nothing;
      // blank secrets on edit are resolved from the stored connection.
      const payload: Record<string, unknown> = {
        serverUrl: draft.serverUrl,
        ...draftAuthPayload(draft),
        ...(editingConnection ? { connectionId: editingConnection.id } : {}),
      }

      const response = await fetch('/api/mcp-connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (data.ok) {
        setTestResult({ status: 'ok', toolCount: data.toolCount, toolNames: data.toolNames })
      } else {
        setTestResult({ status: 'error', message: data.error || 'Connection failed' })
      }
    } catch {
      setTestResult({ status: 'error', message: 'Network error — check the server URL' })
    }
  }

  const submit = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  // 'api_key' is grandfathered in: offered only while editing a server that
  // already uses it, never as a choice for a new one.
  const authModes: McpAuthMode[] =
    editingConnection?.auth.authType === 'api_key'
      ? ['none', 'api_key', 'client_credentials', 'sso']
      : ['none', 'client_credentials', 'sso']

  const modeLabels: Record<McpAuthMode, string> = {
    none: 'None',
    api_key: 'API key (legacy)',
    client_credentials: 'Client credentials',
    sso: 'OAuth 2.0 (SSO)',
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editingConnection ? 'Edit MCP server' : 'Model Context Protocol'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Server name */}
          <div>
            <Label>
              Server name <span className="text-destructive">*</span>
            </Label>
            <Input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Backstory MCP"
            />
          </div>

          {/* Server description */}
          <div>
            <Label>
              Server description <span className="text-destructive">*</span>
            </Label>
            <Textarea
              rows={2}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="What does this server provide?"
            />
          </div>

          {/* Server URL */}
          <div>
            <Label>
              Server URL <span className="text-destructive">*</span>
            </Label>
            <Input
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={draft.serverUrl}
              onChange={(e) => set({ serverUrl: e.target.value })}
              onBlur={probeForOAuth}
              placeholder="Streamable endpoint"
            />
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {discovering ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Enter the complete HTTPS streamable MCP endpoint.
            </p>
          </div>

          {/* Authentication */}
          <div>
            <Label className="mb-2 block">Authentication</Label>
            <div className="flex flex-wrap gap-4">
              {authModes.map((mode) => (
                <label
                  key={mode}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="authMode"
                    value={mode}
                    checked={draft.authMode === mode}
                    onChange={() => {
                      setOauthDetected(false)
                      set({ authMode: mode })
                    }}
                    className="accent-indigo-600"
                  />
                  {modeLabels[mode]}
                </label>
              ))}
            </div>
            {oauthDetected && draft.authMode === 'sso' && (
              <p className="mt-1.5 text-xs text-horizon-700">
                Detected automatically — this server requires OAuth 2.0. Sign in
                below, or switch to client credentials if you were issued a
                client ID and secret.
              </p>
            )}
          </div>

          {/* Conditional: client credentials */}
          {draft.authMode === 'client_credentials' && (
            <div className="space-y-3 rounded-lg border bg-gray-50 p-3">
              <div>
                <Label>
                  Client ID <span className="text-destructive">*</span>
                </Label>
                <Input
                  value={draft.clientId}
                  onChange={(e) => set({ clientId: e.target.value })}
                  placeholder="your-client-id"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
              <div>
                <Label>
                  Client secret <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="password"
                  value={draft.clientSecret}
                  onChange={(e) => set({ clientSecret: e.target.value })}
                  placeholder={
                    editingConnection?.auth.hasClientSecret
                      ? 'Leave blank to keep current secret'
                      : 'your-client-secret'
                  }
                  autoComplete="new-password"
                />
                {editingConnection?.auth.hasClientSecret && !draft.clientSecret && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Leave blank to keep the current secret.
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                We exchange these for an access token on every run. The token
                endpoint is discovered from the server, so the fields below are
                only needed if that discovery fails.
              </p>

              <details className="rounded-md border bg-white p-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced: token URL and scopes
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label>Token URL (optional)</Label>
                    <Input
                      value={draft.tokenUrl}
                      onChange={(e) => set({ tokenUrl: e.target.value })}
                      placeholder="https://auth.example.com/oauth/token"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Auto-discovered from the server if left blank.
                    </p>
                  </div>
                  <div>
                    <Label>Scopes (optional)</Label>
                    <Input
                      value={draft.scopes}
                      onChange={(e) => set({ scopes: e.target.value })}
                      placeholder="read write"
                    />
                  </div>
                </div>
              </details>
            </div>
          )}

          {/* Conditional: SSO (authorization-code) */}
          {draft.authMode === 'sso' && (
            <div className="space-y-3 rounded-lg border bg-gray-50 p-3">
              <Button
                type="button"
                className="w-full"
                disabled={!canConnectSso}
                onClick={connectWithSso}
              >
                Connect with SSO
              </Button>
              <p className="text-xs text-muted-foreground">
                Connect with SSO redirects you to sign in (Okta), then returns
                here and saves the server for you. Fill in the server name and
                URL above first.
              </p>
            </div>
          )}

          {/* Conditional: legacy API key */}
          {draft.authMode === 'api_key' && (
            <div className="space-y-3 rounded-lg border bg-gray-50 p-3">
              <div>
                <Label>API key</Label>
                <Input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  placeholder={
                    editingConnection?.auth.hasApiKey
                      ? 'Leave blank to keep current key'
                      : 'Paste your API key'
                  }
                  autoComplete="new-password"
                />
                {editingConnection?.auth.hasApiKey && !draft.apiKey && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Leave blank to keep the current key.
                  </p>
                )}
              </div>
              <div>
                <Label>Header name (optional)</Label>
                <Input
                  value={draft.headerName}
                  onChange={(e) => set({ headerName: e.target.value })}
                  placeholder="Authorization (Bearer) — or e.g. X-API-Key"
                />
              </div>
            </div>
          )}

          {/* Test connection result */}
          {testResult.status === 'ok' && (
            <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <div>
                <span className="font-medium">Connected</span> — {testResult.toolCount} tool
                {testResult.toolCount !== 1 ? 's' : ''}
                {testResult.toolNames.length > 0 && (
                  <p className="mt-1 text-xs text-green-700">
                    {testResult.toolNames.join(', ')}
                    {testResult.toolCount > testResult.toolNames.length && ' …'}
                  </p>
                )}
              </div>
            </div>
          )}
          {testResult.status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
              <span>{testResult.message}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!canTest || testResult.status === 'testing'}
              onClick={testConnection}
              className="shrink-0"
            >
              {testResult.status === 'testing' ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : null}
              Test connection
            </Button>
            <Button
              className="flex-1"
              disabled={saving || !canCreate}
              onClick={submit}
            >
              {saving ? 'Verifying…' : editingConnection ? 'Verify & save' : 'Verify & create'}
            </Button>
          </div>
          {ssoNeedsRedirect && (
            <p className="text-xs text-muted-foreground">
              Use <span className="font-medium">Connect with SSO</span> above to
              add this server — signing in is what creates it.
            </p>
          )}
          {draft.authMode === 'client_credentials' && !hasClientCredentials && (
            <p className="text-xs text-muted-foreground">
              Enter a client ID and secret to test or save this server.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
