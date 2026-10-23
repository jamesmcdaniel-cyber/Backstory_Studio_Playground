'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Ban, Globe, KeyRound, Shuffle } from 'lucide-react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CopyButton } from '@/components/settings/dialogs'
import { cn } from '@/lib/utils'
import type { ExternalAgentSecrets, ExternalAgentView } from '@/lib/agents/external/types'

/**
 * "Add external agent": register an agent that runs on someone else's
 * infrastructure as a teammate on this roster.
 *
 * Two steps. The form says plainly what the agent will and will not be able
 * to reach (the dashed box is the boundary the roster card also draws), then
 * the credentials step hands over the signing secret and reply key exactly
 * once — nothing here can show them again.
 */

export const REPLY_DEADLINES: Array<{ minutes: number; label: string }> = [
  { minutes: 5, label: '5 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
  { minutes: 1440, label: '24 hours' },
]

const freshSeed = () => `external-${Math.random().toString(36).slice(2, 10)}`

/** The once-only credentials, laid out for handing to the agent's developer. */
export function ExternalAgentSecretsPanel({ secrets, agentName }: { secrets: ExternalAgentSecrets; agentName: string }) {
  const absolute = (path: string) => (typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString())
  const rows: Array<{ label: string; value: string; hint: string; secret?: boolean }> = []
  if (secrets.signingSecret) {
    rows.push({ label: 'Signing secret', value: secrets.signingSecret, hint: 'Verifies that a task really came from Backstory.', secret: true })
  }
  if (secrets.apiKey) {
    rows.push(
      { label: 'Client ID', value: secrets.apiKey.clientId, hint: 'Safe to share — identifies the key.' },
      { label: 'Client secret', value: secrets.apiKey.clientSecret, hint: `Lets ${agentName} reply to tasks sent to it, and nothing else.`, secret: true },
      { label: 'Token URL', value: absolute(secrets.apiKey.tokenUrl), hint: 'Exchange the client ID and secret here for a 15-minute access token.' },
    )
  }
  return (
    <div className="space-y-3">
      <p className="rounded-lg border border-[var(--status-warn-fg)]/30 bg-[var(--status-warn-bg)] px-3 py-2 text-sm text-[var(--status-warn-fg)]">
        Copy these now. Secrets are stored encrypted or hashed and can&apos;t be shown again — rotate to get new ones.
      </p>
      <dl className="space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {row.secret && <KeyRound className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />}
              {row.label}
            </dt>
            <dd className="mt-1 flex items-start gap-2">
              <code className="block min-w-0 flex-1 break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{row.value}</code>
              <CopyButton value={row.value} label="Copy" className="shrink-0" />
            </dd>
            <dd className="mt-1 text-xs text-fg-muted">{row.hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function ExternalAgentDialog({
  open,
  onOpenChange,
  onRegistered,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegistered: (agent: ExternalAgentView) => void
}) {
  const [name, setName] = useState('')
  const [roleLabel, setRoleLabel] = useState('')
  const [description, setDescription] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [deadline, setDeadline] = useState(60)
  const [seed, setSeed] = useState(freshSeed)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ agent: ExternalAgentView; secrets: ExternalAgentSecrets } | null>(null)

  const reset = () => {
    setName(''); setRoleLabel(''); setDescription(''); setWebhookUrl(''); setCapabilities('')
    setDeadline(60); setSeed(freshSeed()); setError(null); setResult(null)
  }
  const close = (next: boolean) => {
    if (!next && busy) return
    onOpenChange(next)
    if (!next) reset()
  }

  const urlProblem = webhookUrl && !webhookUrl.trim().startsWith('https://') ? 'The webhook must start with https://' : null
  const canSubmit = Boolean(name.trim() && webhookUrl.trim()) && !urlProblem && !busy

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/agents/external', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          roleLabel: roleLabel.trim() || null,
          description: description.trim() || null,
          webhookUrl: webhookUrl.trim(),
          capabilities: capabilities.trim() || null,
          replyTimeoutMinutes: deadline,
          avatarSeed: seed,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(response.status === 403 ? 'Only workspace admins can add an external agent.' : data.error || 'Could not add the agent.')
        return
      }
      setResult({ agent: data.externalAgent, secrets: data.secrets })
      onRegistered(data.externalAgent)
      toast.success(`${data.externalAgent.name} joined the roster`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect {result.agent.name}</DialogTitle>
              <DialogDescription>
                Give these to whoever runs the agent. Tasks go to {result.agent.webhookHost}, signed with the secret; the agent answers with its client credentials and the single-use token each task carries.
              </DialogDescription>
            </DialogHeader>
            <ExternalAgentSecretsPanel secrets={result.secrets} agentName={result.agent.name} />
            <DialogFooter>
              <Button onClick={() => close(false)}>I&rsquo;ve saved them</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Add an external agent</DialogTitle>
              <DialogDescription>
                An agent you run elsewhere — your own model, your own code — joins the roster. People can mention it in Slack, give it flow steps and chat with it; each task is sent to its webhook and its reply comes back here.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-4">
              <div className="shrink-0 text-center">
                <span className="block rounded-[1.1rem] border-2 border-dashed border-gray-300 p-1">
                  <AgentAvatar seed={seed} className="h-20 w-16 rounded-[0.9rem]" />
                </span>
                <Button type="button" size="sm" variant="ghost" className="mt-1 h-7 gap-1 px-2 text-xs" onClick={() => setSeed(freshSeed())}>
                  <Shuffle className="h-3 w-3" aria-hidden="true" /> New face
                </Button>
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ext-name">Name</Label>
                  <Input id="ext-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="Renewal Scout" autoFocus />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ext-role">Role <span className="font-normal text-fg-muted">(optional)</span></Label>
                  <Input id="ext-role" value={roleLabel} maxLength={40} onChange={(event) => setRoleLabel(event.target.value)} placeholder="Researcher" />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ext-description">What it does <span className="font-normal text-fg-muted">(optional)</span></Label>
              <Textarea id="ext-description" rows={2} value={description} maxLength={2000} onChange={(event) => setDescription(event.target.value)} placeholder="Researches accounts before renewal calls and drafts a one-page brief." />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ext-webhook">Webhook URL</Label>
              <div className="relative">
                <Globe className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
                <Input
                  id="ext-webhook"
                  type="url"
                  inputMode="url"
                  value={webhookUrl}
                  onChange={(event) => setWebhookUrl(event.target.value)}
                  placeholder="https://agents.example.com/backstory/tasks"
                  className="pl-8"
                  aria-invalid={Boolean(urlProblem)}
                  aria-describedby="ext-webhook-hint"
                />
              </div>
              <p id="ext-webhook-hint" className={cn('text-xs', urlProblem ? 'text-[var(--status-risk-fg)]' : 'text-fg-muted')}>
                {urlProblem ?? 'A public https address. Each task is POSTed here, signed.'}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <div className="space-y-1.5">
                <Label htmlFor="ext-capabilities">Built for <span className="font-normal text-fg-muted">(optional)</span></Label>
                <Textarea id="ext-capabilities" rows={2} value={capabilities} maxLength={4000} onChange={(event) => setCapabilities(event.target.value)} placeholder="What a run with no other instructions should ask it to do." />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ext-deadline">Wait for a reply</Label>
                <select
                  id="ext-deadline"
                  value={deadline}
                  onChange={(event) => setDeadline(Number(event.target.value))}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {REPLY_DEADLINES.map((option) => <option key={option.minutes} value={option.minutes}>{option.label}</option>)}
                </select>
                <p className="text-xs text-fg-muted">Then the run fails.</p>
              </div>
            </div>

            <div className="rounded-xl border-2 border-dashed border-gray-300 px-4 py-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <Ban className="h-4 w-4 text-[var(--status-risk-fg)]" aria-hidden="true" /> No platform tools
              </p>
              <p className="mt-1 text-muted-foreground">
                It can&apos;t use this workspace&apos;s connections, accounts or documents. It sees only what each task sends: the request, who asked, and where it came from.
              </p>
            </div>

            {error && <p role="alert" className="text-sm text-[var(--status-risk-fg)]">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!canSubmit}>Add agent</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
