'use client'

/**
 * Developer API keys.
 *
 * The old section could only MINT: it hardcoded all three scopes, showed the
 * secret in a `window.prompt`, listed live keys as inert text, and never called
 * DELETE /api/api-keys — so a key that leaked could not be revoked from the
 * product at all. Scope choice matters here because `flows:run` executes flows
 * (and bills runs against the workspace); handing every integration a write+run
 * key because the UI offered nothing else is a real exposure, not a nicety.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog, PromptDialog, SecretDialog } from '@/components/settings/dialogs'

type ApiKey = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

// Mirrors the `scopes` enum on /api/api-keys — the server rejects anything else.
const SCOPES: Array<{ value: string; label: string; hint: string }> = [
  { value: 'flows:read', label: 'Read flows', hint: 'List and export flows and their runs.' },
  { value: 'flows:write', label: 'Write flows', hint: 'Create, import, and modify flows.' },
  { value: 'flows:run', label: 'Run flows', hint: 'Trigger executions. Counts against your run limits.' },
]

const fmtDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null

export function DeveloperApiSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loaded, setLoaded] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [scopes, setScopes] = useState<string[]>(['flows:read'])
  const [busy, setBusy] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)

  const load = useCallback(async () => {
    const data = await fetch('/api/api-keys', { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    if (data?.success) setKeys(data.keys ?? [])
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])

  // Reopening the dialog starts from the least-privileged default again rather
  // than inheriting whatever the last key happened to ask for.
  useEffect(() => { if (createOpen) setScopes(['flows:read']) }, [createOpen])

  const create = async (name: string) => {
    if (scopes.length === 0) return toast.error('Choose at least one scope.')
    setBusy('create')
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scopes }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not create that API key.')
      setCreateOpen(false)
      setSecret(data.key.secret)
      await load()
    } finally { setBusy(null) }
  }

  const revoke = async (key: ApiKey) => {
    setBusy(key.id)
    try {
      const response = await fetch('/api/api-keys', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: key.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not revoke that key.')
      setRevoking(null)
      toast.success('API key revoked.')
      await load()
    } finally { setBusy(null) }
  }

  const live = keys.filter((key) => !key.revokedAt)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Scoped credentials for importing, exporting, managing, and running flows over the API.
        </p>
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <KeyRound className="h-3.5 w-3.5" /> Create key
        </Button>
      </div>

      {!loaded ? (
        <div className="h-16 animate-pulse rounded-lg border bg-muted/40" />
      ) : live.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create one to drive flows from your own scripts or CI."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {live.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-[12rem] flex-1">
                <div className="truncate text-sm font-medium">{key.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {key.prefix}…{key.lastUsedAt ? ` · last used ${fmtDate(key.lastUsedAt)}` : ' · never used'}
                  {key.expiresAt ? ` · expires ${fmtDate(key.expiresAt)}` : ''}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {key.scopes.map((scope) => <Badge key={scope} variant="outline" className="font-mono text-[10px]">{scope}</Badge>)}
              </div>
              <Button size="sm" variant="ghost" disabled={busy === key.id} onClick={() => setRevoking(key)}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create an API key"
        description="The secret is shown once. Grant only the scopes the integration needs."
        label="Key name"
        placeholder="CI pipeline"
        confirmLabel="Create key"
        busy={busy === 'create'}
        onSubmit={create}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium leading-none">Scopes</legend>
          {SCOPES.map((scope) => (
            <label key={scope.value} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm">
              <input
                type="checkbox"
                aria-label={scope.label}
                className="mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
                checked={scopes.includes(scope.value)}
                onChange={(event) =>
                  setScopes((prev) =>
                    event.target.checked ? [...prev, scope.value] : prev.filter((value) => value !== scope.value),
                  )
                }
              />
              <span>
                <span className="font-medium">{scope.label}</span>
                <span className="block text-xs text-muted-foreground">{scope.hint}</span>
              </span>
            </label>
          ))}
          {scopes.length === 0 && <p className="text-xs text-destructive">Choose at least one scope.</p>}
        </fieldset>
      </PromptDialog>

      <SecretDialog
        open={secret !== null}
        onOpenChange={(open) => { if (!open) setSecret(null) }}
        title="Your API key"
        secret={secret ?? ''}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null) }}
        title={`Revoke ${revoking?.name ?? ''}?`}
        description="Any script still using this key starts failing immediately. This cannot be undone."
        confirmLabel="Revoke key"
        destructive
        busy={busy === revoking?.id}
        onConfirm={() => revoking && revoke(revoking)}
      />
    </div>
  )
}
