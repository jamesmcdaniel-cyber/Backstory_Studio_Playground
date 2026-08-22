'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

/**
 * Workspace-owned credentials for the built-in integrations.
 *
 * These used to run on one platform-wide key each, so every workspace posted to
 * the same Slack and sent mail from the same address. A workspace now brings its
 * own — and this is where it does that. Without this panel the per-org gate
 * would simply switch those integrations off for customer orgs with no way to
 * turn them back on.
 *
 * The credential is write-only: it is verified against the provider before it is
 * stored, encrypted at rest, and never sent back to the browser. The UI only
 * ever knows whether one exists and where it came from.
 */

const PROVIDERS = ['slack', 'email', 'granola'] as const
type Provider = (typeof PROVIDERS)[number]

type CredentialState = {
  provider: Provider
  label: string
  fieldLabel: string
  hint: string
  docsUrl: string
  hasOwnKey: boolean
  configured: boolean
  source: 'org' | 'env' | null
  /** Slack only — see hasSigningSecret in the route's `state()`. */
  hasSigningSecret?: boolean
}

const url = (provider: Provider) => `/api/integrations/credentials/${provider}`

function CredentialRow({ provider }: { provider: Provider }) {
  const [state, setState] = useState<CredentialState | null>(null)
  const [value, setValue] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch(url(provider), { cache: 'no-store' })
      const body = await response.json()
      if (response.ok) setState(body as CredentialState)
    } catch {
      // A failed status read leaves the row in its loading shell rather than
      // claiming "not connected", which would be a lie the user might act on.
    }
  }, [provider])

  useEffect(() => {
    void load()
  }, [load])

  const needsSigningSecret = provider === 'slack' && !state?.hasSigningSecret

  const save = async () => {
    if (!value.trim() || busy) return
    if (needsSigningSecret && !signingSecret.trim()) return
    setBusy(true)
    try {
      const response = await fetch(url(provider), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential: value.trim(),
          ...(signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
        }),
      })
      const body = await response.json()
      if (!response.ok) {
        toast.error(body?.error || 'Could not save that credential.')
        return
      }
      setState(body as CredentialState)
      setValue('')
      setSigningSecret('')
      toast.success(`${body.label} connected for this workspace.`)
    } catch {
      toast.error('Could not save that credential.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (busy) return
    setBusy(true)
    try {
      const response = await fetch(url(provider), { method: 'DELETE' })
      const body = await response.json()
      if (!response.ok) {
        toast.error(body?.error || 'Could not remove that credential.')
        return
      }
      setState(body as CredentialState)
      toast.success('Credential removed.')
    } catch {
      toast.error('Could not remove that credential.')
    } finally {
      setBusy(false)
    }
  }

  if (!state) {
    return <div className="h-24 animate-pulse rounded-lg border border-gray-200 bg-gray-50" />
  }

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-gray-900">{state.label}</span>
          {state.hasOwnKey ? (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="h-3 w-3" /> This workspace
            </Badge>
          ) : state.source === 'env' ? (
            <Badge variant="outline" className="gap-1">
              <ShieldCheck className="h-3 w-3" /> Platform account
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
        <a
          href={state.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          Get a key <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <p className="mt-1 text-sm text-gray-500">{state.hint}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          type="password"
          // "new-password", not "off": Chrome's password manager ignores "off"
          // on password fields — it filled the user's saved site password here
          // and paired their email into the nearest text input as a username.
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={state.hasOwnKey ? `Replace ${state.fieldLabel.toLowerCase()}` : state.fieldLabel}
          className="min-w-[16rem] flex-1"
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save()
          }}
        />
        {provider === 'slack' && (
          <Input
            type="password"
            autoComplete="new-password"
            value={signingSecret}
            onChange={(event) => setSigningSecret(event.target.value)}
            placeholder={state.hasSigningSecret ? 'Replace signing secret (optional)' : 'Signing secret'}
            className="min-w-[16rem] flex-1"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
          />
        )}
        <Button onClick={() => void save()} disabled={!value.trim() || (needsSigningSecret && !signingSecret.trim()) || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : state.hasOwnKey ? 'Replace' : 'Connect'}
        </Button>
        {state.hasOwnKey && (
          <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
            Remove
          </Button>
        )}
      </div>
      {provider === 'slack' && (
        <p className="mt-2 text-xs text-gray-400">
          From your Slack app&rsquo;s Basic Information page — the signing secret lets Backstory verify events your workspace
          sends it. Set your app&rsquo;s Event Subscriptions request URL to this workspace&rsquo;s events endpoint after saving.
        </p>
      )}
    </div>
  )
}

export function WorkspaceCredentialsPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Workspace keys</CardTitle>
        <CardDescription>
          Connect these with your own account, so your agents post and send as your workspace — never through a shared
          one. Keys are verified when you save them, encrypted at rest, and never shown again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {PROVIDERS.map((provider) => (
          <CredentialRow key={provider} provider={provider} />
        ))}
      </CardContent>
    </Card>
  )
}
