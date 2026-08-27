'use client'

import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export type ExternalSecretProviderSummary = {
  id: string
  name: string
  provider: 'aws' | 'gcp' | 'azure' | 'vault'
  config: Record<string, unknown>
  allowedPathPrefix: string
  cacheTtlSeconds: number
  status: string
  lastVerifiedAt: string | null
  lastError: string | null
}

const PROVIDER_LABEL: Record<ExternalSecretProviderSummary['provider'], string> = {
  aws: 'AWS Secrets Manager',
  gcp: 'Google Secret Manager',
  azure: 'Azure Key Vault',
  vault: 'HashiCorp Vault KV v2',
}

type Draft = {
  id?: string
  name: string
  provider: ExternalSecretProviderSummary['provider']
  region: string
  projectId: string
  vaultUrl: string
  baseUrl: string
  mount: string
  namespace: string
  vaultToken: string
  awsAccessKeyId: string
  awsSecretAccessKey: string
  awsSessionToken: string
  gcpServiceAccountJson: string
  azureTenantId: string
  azureClientId: string
  azureClientSecret: string
  allowedPathPrefix: string
  cacheTtlSeconds: string
}

const EMPTY: Draft = {
  name: '',
  provider: 'aws',
  region: '',
  projectId: '',
  vaultUrl: '',
  baseUrl: '',
  mount: 'secret',
  namespace: '',
  vaultToken: '',
  awsAccessKeyId: '',
  awsSecretAccessKey: '',
  awsSessionToken: '',
  gcpServiceAccountJson: '',
  azureTenantId: '',
  azureClientId: '',
  azureClientSecret: '',
  allowedPathPrefix: '',
  cacheTtlSeconds: '60',
}

function draftOf(row: ExternalSecretProviderSummary): Draft {
  return {
    ...EMPTY,
    id: row.id,
    name: row.name,
    provider: row.provider,
    region: String(row.config.region ?? ''),
    projectId: String(row.config.projectId ?? ''),
    vaultUrl: String(row.config.vaultUrl ?? ''),
    baseUrl: String(row.config.baseUrl ?? ''),
    mount: String(row.config.mount ?? 'secret'),
    namespace: String(row.config.namespace ?? ''),
    allowedPathPrefix: row.allowedPathPrefix,
    cacheTtlSeconds: String(row.cacheTtlSeconds),
  }
}

function configOf(draft: Draft): Record<string, string> {
  switch (draft.provider) {
    case 'aws': return draft.region ? { region: draft.region } : {}
    case 'gcp': return { projectId: draft.projectId }
    case 'azure': return { vaultUrl: draft.vaultUrl }
    case 'vault': return {
      baseUrl: draft.baseUrl,
      mount: draft.mount || 'secret',
      ...(draft.namespace ? { namespace: draft.namespace } : {}),
    }
  }
}

export function ExternalSecretProviders({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<ExternalSecretProviderSummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/external-secret-providers', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    setRows(Array.isArray(data.providers) ? data.providers : [])
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  const set = (key: keyof Draft) => (value: string) => setDraft((current) => current ? { ...current, [key]: value } : current)

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const response = await fetch('/api/external-secret-providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name,
          provider: draft.provider,
          config: configOf(draft),
          ...(draft.vaultToken ? { vaultToken: draft.vaultToken } : {}),
          ...(draft.awsAccessKeyId ? { awsAccessKeyId: draft.awsAccessKeyId } : {}),
          ...(draft.awsSecretAccessKey ? { awsSecretAccessKey: draft.awsSecretAccessKey } : {}),
          ...(draft.awsSessionToken ? { awsSessionToken: draft.awsSessionToken } : {}),
          ...(draft.gcpServiceAccountJson ? { gcpServiceAccountJson: draft.gcpServiceAccountJson } : {}),
          ...(draft.azureTenantId ? { azureTenantId: draft.azureTenantId } : {}),
          ...(draft.azureClientId ? { azureClientId: draft.azureClientId } : {}),
          ...(draft.azureClientSecret ? { azureClientSecret: draft.azureClientSecret } : {}),
          allowedPathPrefix: draft.allowedPathPrefix,
          cacheTtlSeconds: Number(draft.cacheTtlSeconds) || 0,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save the secret provider.')
      toast.success(draft.id ? 'Secret provider updated.' : 'Secret provider added.')
      setDraft(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the secret provider.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: ExternalSecretProviderSummary) => {
    if (!window.confirm(`Delete “${row.name}”?`)) return
    setDeleting(row.id)
    try {
      const response = await fetch(`/api/external-secret-providers?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not delete the secret provider.')
      setRows((current) => current.filter((item) => item.id !== row.id))
      toast.success('Secret provider deleted.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the secret provider.')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">External secret providers</h3>
          <p className="text-xs text-muted-foreground/80">Keep credential values in AWS, Google Cloud, Azure, or Vault and resolve them only when a run needs them.</p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={() => setDraft({ ...EMPTY })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add provider
          </Button>
        )}
      </div>
      <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
        {loaded && rows.length === 0 && <p className="px-3 py-3 text-sm text-muted-foreground">No external secret providers configured.</p>}
        {!loaded && <p className="px-3 py-3 text-sm text-muted-foreground">Loading secret providers…</p>}
        {rows.map((row) => (
          <div key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="grid h-7 w-7 place-items-center rounded-md border border-border/60 bg-muted"><KeyRound className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{row.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {PROVIDER_LABEL[row.provider]}{row.allowedPathPrefix ? ` · ${row.allowedPathPrefix}/…` : ''}
                {row.lastError ? ` · ${row.lastError}` : ''}
              </span>
            </span>
            {canManage && (
              <span className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setDraft(draftOf(row))}><Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit</Button>
                <Button variant="ghost" size="sm" className="text-red-600" loading={deleting === row.id} onClick={() => void remove(row)}><Trash2 className="h-3.5 w-3.5" /></Button>
              </span>
            )}
            <Badge variant={row.status === 'verified' ? 'good' : row.status === 'error' ? 'warn' : 'secondary'}>
              {row.status === 'unverified' ? 'Ready to test' : row.status}
            </Badge>
          </div>
        ))}
      </div>

      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && !saving && setDraft(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Edit secret provider' : 'Add secret provider'}</DialogTitle>
            <DialogDescription>Provider bootstrap credentials are encrypted locally; referenced values remain in the external manager.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 py-2 sm:grid-cols-2">
              <div className="space-y-2"><Label>Name</Label><Input value={draft.name} onChange={(event) => set('name')(event.target.value)} placeholder="Production secrets" /></div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select value={draft.provider} onValueChange={(value) => setDraft({ ...draft, provider: value as Draft['provider'] })} disabled={Boolean(draft.id)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(PROVIDER_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {draft.provider === 'aws' && (
                <>
                  <div className="space-y-2 sm:col-span-2"><Label>AWS region (optional)</Label><Input value={draft.region} onChange={(event) => set('region')(event.target.value)} placeholder="us-east-1" /></div>
                  <div className="space-y-2"><Label>Access key ID {draft.id ? '(leave blank to keep)' : ''}</Label><Input autoComplete="off" value={draft.awsAccessKeyId} onChange={(event) => set('awsAccessKeyId')(event.target.value)} /></div>
                  <div className="space-y-2"><Label>Secret access key</Label><Input type="password" autoComplete="off" value={draft.awsSecretAccessKey} onChange={(event) => set('awsSecretAccessKey')(event.target.value)} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>Session token (optional)</Label><Input type="password" autoComplete="off" value={draft.awsSessionToken} onChange={(event) => set('awsSessionToken')(event.target.value)} /></div>
                </>
              )}
              {draft.provider === 'gcp' && (
                <>
                  <div className="space-y-2 sm:col-span-2"><Label>Google Cloud project ID</Label><Input value={draft.projectId} onChange={(event) => set('projectId')(event.target.value)} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>Service-account JSON {draft.id ? '(leave blank to keep)' : ''}</Label><textarea className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" value={draft.gcpServiceAccountJson} onChange={(event) => set('gcpServiceAccountJson')(event.target.value)} /></div>
                </>
              )}
              {draft.provider === 'azure' && (
                <>
                  <div className="space-y-2 sm:col-span-2"><Label>Key Vault URL</Label><Input value={draft.vaultUrl} onChange={(event) => set('vaultUrl')(event.target.value)} placeholder="https://acme.vault.azure.net" /></div>
                  <div className="space-y-2"><Label>Tenant ID {draft.id ? '(leave credentials blank to keep)' : ''}</Label><Input value={draft.azureTenantId} onChange={(event) => set('azureTenantId')(event.target.value)} /></div>
                  <div className="space-y-2"><Label>Client ID</Label><Input value={draft.azureClientId} onChange={(event) => set('azureClientId')(event.target.value)} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>Client secret</Label><Input type="password" autoComplete="off" value={draft.azureClientSecret} onChange={(event) => set('azureClientSecret')(event.target.value)} /></div>
                </>
              )}
              {draft.provider === 'vault' && (
                <>
                  <div className="space-y-2 sm:col-span-2"><Label>Vault URL</Label><Input value={draft.baseUrl} onChange={(event) => set('baseUrl')(event.target.value)} placeholder="https://vault.example.com" /></div>
                  <div className="space-y-2"><Label>KV mount</Label><Input value={draft.mount} onChange={(event) => set('mount')(event.target.value)} /></div>
                  <div className="space-y-2"><Label>Namespace (optional)</Label><Input value={draft.namespace} onChange={(event) => set('namespace')(event.target.value)} /></div>
                  <div className="space-y-2 sm:col-span-2"><Label>Vault token {draft.id ? '(leave blank to keep)' : ''}</Label><Input type="password" autoComplete="off" value={draft.vaultToken} onChange={(event) => set('vaultToken')(event.target.value)} /></div>
                </>
              )}
              <div className="space-y-2"><Label>Allowed path prefix</Label><Input value={draft.allowedPathPrefix} onChange={(event) => set('allowedPathPrefix')(event.target.value)} placeholder="production/backstory" /></div>
              <div className="space-y-2"><Label>Cache seconds (0–300)</Label><Input type="number" min={0} max={300} value={draft.cacheTtlSeconds} onChange={(event) => set('cacheTtlSeconds')(event.target.value)} /></div>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button><Button onClick={() => void save()} loading={saving} disabled={!draft?.name.trim()}>Save provider</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
