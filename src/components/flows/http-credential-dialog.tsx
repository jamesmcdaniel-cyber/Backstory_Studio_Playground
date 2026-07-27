'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Globe2, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'

export const HTTP_AUTH_OPTIONS = [
  { value: 'basic', label: 'Basic Auth', description: 'Username and password' },
  { value: 'bearer', label: 'Bearer Auth', description: 'Bearer access token' },
  { value: 'custom', label: 'Custom Auth', description: 'Custom JSON headers and query values' },
  { value: 'digest', label: 'Digest Auth', description: 'HTTP Digest username and password' },
  { value: 'header', label: 'Header Auth', description: 'A secret value in a named header' },
  { value: 'oauth1', label: 'OAuth1 API', description: 'OAuth 1.0 HMAC-SHA1 credentials' },
  { value: 'oauth2', label: 'OAuth2 API', description: 'Access token or client credentials' },
  { value: 'query', label: 'Query Auth', description: 'A secret value in a query parameter' },
] as const

export type HttpAuthOption = (typeof HTTP_AUTH_OPTIONS)[number]['value']
export type HttpCredentialSummary = {
  id: string
  name: string
  authType: HttpAuthOption
  allowedHost: string
  status: string
  lastVerifiedAt: string | null
  lastError: string | null
}

const inputClass = 'h-10'

function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  )
}

export function HttpCredentialDialog({
  open,
  onOpenChange,
  requestUrl,
  requestMethod,
  initialAuthType = 'basic',
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  requestUrl: string
  requestMethod: string
  initialAuthType?: HttpAuthOption
  onSaved: (credential: HttpCredentialSummary) => void
}) {
  const [name, setName] = useState('')
  const [authType, setAuthType] = useState<HttpAuthOption>(initialAuthType)
  const [config, setConfig] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const host = useMemo(() => {
    try {
      return new URL(requestUrl).hostname
    } catch {
      return ''
    }
  }, [requestUrl])

  useEffect(() => {
    if (!open) return
    setAuthType(initialAuthType)
    setConfig({})
    setName(host ? `${host} ${HTTP_AUTH_OPTIONS.find((option) => option.value === initialAuthType)?.label || 'credential'}` : '')
  }, [host, initialAuthType, open])

  const set = (key: string) => (value: string) => setConfig((current) => ({ ...current, [key]: value }))

  const verifyAndSave = async () => {
    if (!host) {
      toast.error('Enter a valid request URL before setting up credentials.')
      return
    }
    setSaving(true)
    try {
      const response = await fetch('/api/http-credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, authType, url: requestUrl, method: requestMethod, config }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'The API could not verify these credentials.')
        return
      }
      toast.success('Credential verified and saved.')
      onSaved(data.credential)
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-6 py-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-horizon-50 text-horizon-700">
              <Globe2 className="h-5 w-5" />
            </span>
            <div>
              <DialogTitle>Set up HTTP credential</DialogTitle>
              <DialogDescription className="mt-1">
                Verify once, then reuse it in HTTP nodes for the same API host.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          <div className="flex items-center gap-2 rounded-lg border border-horizon-100 bg-horizon-50/70 px-3 py-2 text-sm text-horizon-800">
            <ShieldCheck className="h-4 w-4" />
            This credential will be encrypted and restricted to <strong>{host || 'the request host'}</strong>.
          </div>

          <SecretField id="credential-name" label="Credential name" value={name} onChange={setName} placeholder="Production API credential" />

          <div className="space-y-2">
            <Label>Authentication method</Label>
            <Select value={authType} onValueChange={(value) => { setAuthType(value as HttpAuthOption); setConfig({}) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HTTP_AUTH_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="font-medium">{option.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{option.description}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {(authType === 'basic' || authType === 'digest') && (
              <>
                <SecretField id="credential-username" label="Username" value={config.username || ''} onChange={set('username')} />
                <SecretField id="credential-password" label="Password" value={config.password || ''} onChange={set('password')} secret />
              </>
            )}
            {authType === 'bearer' && (
              <div className="sm:col-span-2">
                <SecretField id="credential-token" label="Bearer token" value={config.token || ''} onChange={set('token')} secret />
              </div>
            )}
            {(authType === 'header' || authType === 'query') && (
              <>
                <SecretField
                  id="credential-key-name"
                  label={authType === 'header' ? 'Header name' : 'Query parameter name'}
                  value={config.name || ''}
                  onChange={set('name')}
                  placeholder={authType === 'header' ? 'X-API-Key' : 'api_key'}
                />
                <SecretField id="credential-key-value" label="Value" value={config.value || ''} onChange={set('value')} secret />
              </>
            )}
            {authType === 'oauth1' && (
              <>
                <SecretField id="oauth1-consumer-key" label="Consumer key" value={config.consumerKey || ''} onChange={set('consumerKey')} />
                <SecretField id="oauth1-consumer-secret" label="Consumer secret" value={config.consumerSecret || ''} onChange={set('consumerSecret')} secret />
                <SecretField id="oauth1-token" label="Access token" value={config.token || ''} onChange={set('token')} />
                <SecretField id="oauth1-token-secret" label="Token secret" value={config.tokenSecret || ''} onChange={set('tokenSecret')} secret />
              </>
            )}
            {authType === 'oauth2' && (
              <>
                <div className="sm:col-span-2">
                  <SecretField
                    id="oauth2-access-token"
                    label="Existing access token"
                    value={config.accessToken || ''}
                    onChange={set('accessToken')}
                    placeholder="Use this, or configure client credentials below"
                    secret
                  />
                </div>
                <div className="sm:col-span-2 flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
                  <span className="h-px flex-1 bg-border" /> or client credentials <span className="h-px flex-1 bg-border" />
                </div>
                <div className="sm:col-span-2">
                  <SecretField id="oauth2-token-url" label="Token URL" value={config.tokenUrl || ''} onChange={set('tokenUrl')} placeholder="https://identity.example.com/oauth/token" />
                </div>
                <div className="sm:col-span-2">
                  <SecretField
                    id="oauth2-refresh-token"
                    label="Refresh token (optional)"
                    value={config.refreshToken || ''}
                    onChange={set('refreshToken')}
                    placeholder="Exchanged for a fresh access token on every run"
                    secret
                  />
                </div>
                <SecretField id="oauth2-client-id" label="Client ID" value={config.clientId || ''} onChange={set('clientId')} />
                <SecretField id="oauth2-client-secret" label="Client secret" value={config.clientSecret || ''} onChange={set('clientSecret')} secret />
                <SecretField id="oauth2-scope" label="Scopes" value={config.scope || ''} onChange={set('scope')} placeholder="read write" />
                <SecretField id="oauth2-audience" label="Audience (optional)" value={config.audience || ''} onChange={set('audience')} />
              </>
            )}
          </div>

          {authType === 'custom' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="custom-auth-headers">Headers JSON</Label>
                <Textarea
                  id="custom-auth-headers"
                  rows={6}
                  value={config.headersJson || ''}
                  onChange={(event) => set('headersJson')(event.target.value)}
                  placeholder={'{\n  "X-API-Key": "secret"\n}'}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="custom-auth-query">Query parameters JSON</Label>
                <Textarea
                  id="custom-auth-query"
                  rows={6}
                  value={config.queryJson || ''}
                  onChange={(event) => set('queryJson')(event.target.value)}
                  placeholder={'{\n  "api_key": "secret"\n}'}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="border-t bg-muted/30 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={verifyAndSave} disabled={saving || !name.trim() || !host}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {saving ? 'Verifying…' : 'Verify & save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
