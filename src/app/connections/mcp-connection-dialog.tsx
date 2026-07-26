'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// ── Types ────────────────────────────────────────────────────────────────────

type AuthType = 'none' | 'api_key' | 'oauth2'

export type McpConnectionDraft = {
  name: string
  description: string
  serverUrl: string
  authType: AuthType
  // api_key fields
  apiKey: string
  headerName: string
  // oauth2 fields
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
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const emptyDraft: McpConnectionDraft = {
  name: '',
  description: '',
  serverUrl: '',
  authType: 'none',
  apiKey: '',
  headerName: '',
  clientId: '',
  clientSecret: '',
  tokenUrl: '',
  scopes: '',
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (draft: McpConnectionDraft) => Promise<void>
  editingConnection?: SerializedConnection | null
}) {
  const [draft, setDraft] = useState<McpConnectionDraft>(emptyDraft)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestResult>({ status: 'idle' })
  // Set once OAuth discovery (on server-URL blur) finds an authorization
  // endpoint, so we can explain why authType was auto-switched to oauth2.
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
        authType: editingConnection.auth.authType,
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
      setDraft(emptyDraft)
    }
    setTestResult({ status: 'idle' })
    setOauthDetected(false)
  }, [editingConnection, open])

  const set = (patch: Partial<McpConnectionDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }))

  // Reset test result whenever auth or URL changes
  useEffect(() => {
    setTestResult({ status: 'idle' })
  }, [draft.serverUrl, draft.authType, draft.apiKey, draft.clientId, draft.clientSecret, draft.tokenUrl])

  // Probe the server for OAuth on blur, so leaving the default "None" auth
  // selected doesn't silently send an unauthenticated request that's bound to
  // fail. Only acts while the user hasn't already picked an auth type
  // themselves — it won't override an explicit api_key/oauth2 choice.
  const probeForOAuth = async () => {
    const url = draft.serverUrl.trim()
    if (!url || draft.authType !== 'none') return
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
        set({ authType: 'oauth2' })
      }
    } catch {
      // Inconclusive — leave the user's current selection alone.
    } finally {
      setDiscovering(false)
    }
  }

  const canCreate = Boolean(draft.name.trim() && draft.serverUrl.trim())
  const canTest = Boolean(draft.serverUrl.trim())
  // SSO (authorization-code) flow only needs a name + server URL — the rest
  // (client registration, tokens) is handled server-side after Okta login.
  const canConnectSso = Boolean(draft.name.trim() && draft.serverUrl.trim())

  // Full-page navigation so the browser follows the OAuth redirect chain
  // (our /start route → Okta → /callback → back to the MCP servers tab).
  const connectWithSso = () => {
    if (!canConnectSso) return
    const params = new URLSearchParams({
      serverUrl: draft.serverUrl.trim(),
      name: draft.name.trim(),
      returnTo: '/integrations?tab=servers',
    })
    if (editingConnection) params.set('connectionId', editingConnection.id)
    window.location.href = `/api/mcp-connections/oauth/start?${params.toString()}`
  }

  const testConnection = async () => {
    setTestResult({ status: 'testing' })
    try {
      // Build the payload — omit secret fields that are blank on edit
      // (the test endpoint gets plaintext; it doesn't persist anything)
      const payload: Record<string, unknown> = {
        serverUrl: draft.serverUrl,
        authType: draft.authType,
        ...(editingConnection ? { connectionId: editingConnection.id } : {}),
      }
      if (draft.authType === 'api_key') {
        if (draft.apiKey) payload.apiKey = draft.apiKey
        if (draft.headerName) payload.headerName = draft.headerName
      }
      if (draft.authType === 'oauth2') {
        if (draft.clientId) payload.clientId = draft.clientId
        if (draft.clientSecret) payload.clientSecret = draft.clientSecret
        if (draft.tokenUrl) payload.tokenUrl = draft.tokenUrl
        if (draft.scopes) payload.scopes = draft.scopes
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
            <div className="flex gap-4">
              {(['none', 'api_key', 'oauth2'] as const).map((type) => {
                const labels: Record<AuthType, string> = {
                  none: 'None',
                  api_key: 'API key',
                  oauth2: 'OAuth 2.0',
                }
                return (
                  <label
                    key={type}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="authType"
                      value={type}
                      checked={draft.authType === type}
                      onChange={() => {
                        setOauthDetected(false)
                        set({ authType: type })
                      }}
                      className="accent-indigo-600"
                    />
                    {labels[type]}
                  </label>
                )
              })}
            </div>
            {oauthDetected && draft.authType === 'oauth2' && (
              <p className="mt-1.5 text-xs text-horizon-700">
                Detected automatically — this server requires OAuth 2.0.
              </p>
            )}
          </div>

          {/* Conditional: API key fields */}
          {draft.authType === 'api_key' && (
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

          {/* Conditional: OAuth 2.0 fields */}
          {draft.authType === 'oauth2' && (
            <div className="space-y-3 rounded-lg border bg-gray-50 p-3">
              {/* Primary path: user-consent / Okta SSO via authorization-code flow */}
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
                here. Fill in the server name and URL above first.
              </p>

              {/* Advanced: pre-issued client credentials for servers that support it */}
              <details className="rounded-md border bg-white p-2">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced: client credentials
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <Label>Client ID</Label>
                    <Input
                      value={draft.clientId}
                      onChange={(e) => set({ clientId: e.target.value })}
                      placeholder="your-client-id"
                    />
                  </div>
                  <div>
                    <Label>Client secret</Label>
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
                  <div>
                    <Label>Token URL (optional)</Label>
                    <Input
                      value={draft.tokenUrl}
                      onChange={(e) => set({ tokenUrl: e.target.value })}
                      placeholder="https://auth.example.com/oauth/token"
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
        </div>
      </DialogContent>
    </Dialog>
  )
}
