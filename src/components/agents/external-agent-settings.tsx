'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Globe, Loader2, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { ExternalAgentSecretsPanel, REPLY_DEADLINES } from './external-agent-dialog'
import type { ExternalAgentSecrets, ExternalAgentView } from '@/lib/agents/external/types'

/**
 * Managing one external agent: where its tasks go, how long a run waits for
 * it, pausing it, rotating either credential, and removing it. Shown in place
 * of the agent setup form — an external agent has no instructions, model or
 * tools of ours to configure.
 */
export function ExternalAgentSettings({ agentId, onChanged, onRemoved }: { agentId: string; onChanged: () => void; onRemoved: () => void }) {
  const [view, setView] = useState<ExternalAgentView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [deadline, setDeadline] = useState(60)
  const [busy, setBusy] = useState<string | null>(null)
  const [secrets, setSecrets] = useState<ExternalAgentSecrets | null>(null)
  const [confirming, setConfirming] = useState<'remove' | 'signing_secret' | 'api_key' | null>(null)

  const adopt = (next: ExternalAgentView) => {
    setView(next)
    setWebhookUrl(next.webhookUrl)
    setCapabilities(next.capabilities ?? '')
    setDeadline(next.replyTimeoutMinutes)
  }

  const load = useCallback(async () => {
    const response = await fetch(`/api/agents/external/${agentId}`, { cache: 'no-store' }).catch(() => null)
    const data = response ? await response.json().catch(() => ({})) : {}
    if (!response?.ok || !data.externalAgent) setLoadError(data.error || 'Could not load this agent’s delivery settings.')
    else adopt(data.externalAgent)
  }, [agentId])
  useEffect(() => { void load() }, [load])

  const call = async (key: string, path: string, init: RequestInit) => {
    setBusy(key)
    try {
      const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' } })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(response.status === 403 ? 'Only workspace admins can change an external agent.' : data.error || 'That did not work.')
        return null
      }
      return data
    } finally {
      setBusy(null)
    }
  }

  const dirty = Boolean(view) && (webhookUrl.trim() !== view!.webhookUrl || (capabilities.trim() || null) !== (view!.capabilities ?? null) || deadline !== view!.replyTimeoutMinutes)

  const save = async () => {
    const data = await call('save', `/api/agents/external/${agentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ webhookUrl: webhookUrl.trim(), capabilities: capabilities.trim() || null, replyTimeoutMinutes: deadline }),
    })
    if (!data) return
    adopt(data.externalAgent)
    onChanged()
    toast.success('Saved')
  }

  const setEnabled = async (enabled: boolean) => {
    const data = await call('enable', `/api/agents/external/${agentId}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
    if (!data) return
    adopt(data.externalAgent)
    onChanged()
    toast.success(enabled ? `${data.externalAgent.name} resumed` : `${data.externalAgent.name} paused — it gets no new tasks`)
  }

  const rotate = async (credential: 'signing_secret' | 'api_key') => {
    const data = await call(credential, `/api/agents/external/${agentId}/rotate`, { method: 'POST', body: JSON.stringify({ credential }) })
    if (!data) return
    adopt(data.externalAgent)
    setSecrets(data.secrets)
  }

  const remove = async () => {
    const data = await call('remove', `/api/agents/external/${agentId}`, { method: 'DELETE' })
    if (!data) return
    toast.success(`${view?.name ?? 'The agent'} was removed`)
    onRemoved()
  }

  if (loadError) return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{loadError}</p>
  if (!view) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading delivery settings…
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">Delivery</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">Where {view.name}&apos;s tasks go, and how long a run waits for its reply.</p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" loading={busy === 'enable'} onClick={() => setEnabled(!view.enabled)}>
          {view.enabled ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />}
          {view.enabled ? 'Pause' : 'Resume'}
        </Button>
      </div>

      {!view.enabled && (
        <p className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-muted-foreground">
          Paused: it receives no new tasks. Replies to tasks already sent still land.
        </p>
      )}

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="ext-edit-webhook">Webhook URL</Label>
          <div className="relative">
            <Globe className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
            <Input id="ext-edit-webhook" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} className="pl-8" />
          </div>
          <p className="text-xs text-fg-muted">
            {view.lastDelivery
              ? view.lastDelivery.status === 'delivered'
                ? `Last task delivered ${new Date(view.lastDelivery.at).toLocaleString()}.`
                : `Last delivery failed ${new Date(view.lastDelivery.at).toLocaleString()}${view.lastDelivery.error ? `: ${view.lastDelivery.error}` : ''}.`
              : 'No task sent yet.'}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div className="space-y-1.5">
            <Label htmlFor="ext-edit-capabilities">Built for</Label>
            <Textarea id="ext-edit-capabilities" rows={2} value={capabilities} maxLength={4000} onChange={(event) => setCapabilities(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ext-edit-deadline">Wait for a reply</Label>
            <select
              id="ext-edit-deadline"
              value={deadline}
              onChange={(event) => setDeadline(Number(event.target.value))}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[...REPLY_DEADLINES, ...(REPLY_DEADLINES.some((option) => option.minutes === view.replyTimeoutMinutes) ? [] : [{ minutes: view.replyTimeoutMinutes, label: `${view.replyTimeoutMinutes} minutes` }])].map((option) => (
                <option key={option.minutes} value={option.minutes}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} loading={busy === 'save'} disabled={!dirty}>Save changes</Button>
        </div>
      </div>

      <div className="space-y-3 border-t pt-5">
        <div>
          <h3 className="text-base font-semibold text-foreground">Credentials</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">Rotating replaces a credential at once; the old one stops working.</p>
        </div>
        <ul className="divide-y rounded-xl border">
          <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Signing secret</span>
              <span className="block text-xs text-fg-muted">
                {view.signingSecretRotatedAt ? `Rotated ${new Date(view.signingSecretRotatedAt).toLocaleDateString()}` : `Set ${new Date(view.createdAt).toLocaleDateString()}`}
              </span>
            </span>
            <Button size="sm" variant="outline" className="gap-1.5" loading={busy === 'signing_secret'} onClick={() => setConfirming('signing_secret')}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Rotate
            </Button>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Reply key</span>
              <span className="block truncate font-mono text-xs text-fg-muted">
                {view.apiKey && !view.apiKey.revoked
                  ? `${view.apiKey.clientId ?? 'key'}${view.apiKey.expiresAt ? ` — expires ${new Date(view.apiKey.expiresAt).toLocaleDateString()}` : ''}`
                  : 'Revoked — the agent cannot reply until you issue a new key'}
              </span>
            </span>
            <Button size="sm" variant="outline" className="gap-1.5" loading={busy === 'api_key'} onClick={() => setConfirming('api_key')}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> {view.apiKey && !view.apiKey.revoked ? 'Rotate' : 'Issue key'}
            </Button>
          </li>
        </ul>
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-5">
        <p className="text-sm text-muted-foreground">Removing revokes its key, deletes its endpoint and fails any task still waiting on it.</p>
        <Button variant="ghost" className="shrink-0 gap-1.5 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => setConfirming('remove')}>
          <Trash2 className="h-4 w-4" aria-hidden="true" /> Remove
        </Button>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => { if (!open) setConfirming(null) }}
        title={confirming === 'remove' ? `Remove ${view.name}?` : confirming === 'signing_secret' ? 'Rotate the signing secret?' : 'Rotate the reply key?'}
        description={
          confirming === 'remove'
            ? 'Its key stops working, its endpoint and secret are deleted, and tasks waiting on it fail. Its past runs stay in history.'
            : confirming === 'signing_secret'
              ? 'The next task is signed with a new secret. Update the agent before then, or it will reject the delivery.'
              : 'The current key and every token minted from it stop working now. Replies need the new key.'
        }
        confirmLabel={confirming === 'remove' ? 'Remove agent' : 'Rotate'}
        destructive={confirming === 'remove'}
        busy={busy !== null}
        onConfirm={async () => {
          const action = confirming
          setConfirming(null)
          if (action === 'remove') await remove()
          else if (action) await rotate(action)
        }}
      />

      <Dialog open={secrets !== null} onOpenChange={(open) => { if (!open) setSecrets(null) }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New credential for {view.name}</DialogTitle>
            <DialogDescription>Hand this to whoever runs the agent.</DialogDescription>
          </DialogHeader>
          {secrets && <ExternalAgentSecretsPanel secrets={secrets} agentName={view.name} />}
          <DialogFooter>
            <Button onClick={() => setSecrets(null)}>I&rsquo;ve saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
