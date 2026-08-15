'use client'

/**
 * Configure one API endpoint on an agent — the same options as the flow HTTP
 * step (method, URL, auth, query, headers, body, cURL import) in a dialog.
 * Saved endpoints become named tools the agent can call; `{{param}}`
 * placeholders anywhere in the request become the tool's typed inputs, filled
 * by the agent at call time.
 */

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Plus, TerminalSquare, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  HttpCredentialDialog,
  HTTP_AUTH_OPTIONS,
  type HttpAuthOption,
  type HttpCredentialSummary,
} from '@/components/flows/http-credential-dialog'
import { ImportCurlDialog } from '@/components/flows/import-curl-dialog'
import { endpointParams, type AgentHttpEndpoint } from '@/lib/integrations/http-endpoints'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

type Pair = { key: string; value: string }

const toPairs = (record: Record<string, string> | undefined): Pair[] =>
  Object.entries(record ?? {}).map(([key, value]) => ({ key, value }))

const fromPairs = (pairs: Pair[]): Record<string, string> | undefined => {
  const entries = pairs.filter((pair) => pair.key.trim())
  return entries.length ? Object.fromEntries(entries.map((pair) => [pair.key.trim(), pair.value])) : undefined
}

function PairsEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string
  pairs: Pair[]
  onChange: (pairs: Pair[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
      {pairs.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">None.</p>
      ) : (
        <div className="mt-1.5 space-y-1.5">
          {pairs.map((pair, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                className="h-8 flex-[2] text-xs"
                value={pair.key}
                placeholder={keyPlaceholder}
                onChange={(event) => onChange(pairs.map((p, i) => (i === index ? { ...p, key: event.target.value } : p)))}
              />
              <Input
                className="h-8 flex-[3] text-xs"
                value={pair.value}
                placeholder={valuePlaceholder}
                onChange={(event) => onChange(pairs.map((p, i) => (i === index ? { ...p, value: event.target.value } : p)))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove ${label.toLowerCase()} row`}
                onClick={() => onChange(pairs.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function AgentHttpEndpointDialog({
  open,
  onOpenChange,
  endpoint,
  onSave,
  connections,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Existing endpoint to edit, or null to create a new one. */
  endpoint: AgentHttpEndpoint | null
  onSave: (endpoint: AgentHttpEndpoint) => void
  /** Connected integrations usable as predefined auth (org MCP connections). */
  connections: { id: string; name: string }[]
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [method, setMethod] = useState<AgentHttpEndpoint['method']>('GET')
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState<Pair[]>([])
  const [headers, setHeaders] = useState<Pair[]>([])
  const [bodyMode, setBodyMode] = useState<'none' | 'json'>('none')
  const [body, setBody] = useState('')
  const [authMode, setAuthMode] = useState<'predefined' | 'generic'>('generic')
  const [connectionId, setConnectionId] = useState('')
  const [credentialId, setCredentialId] = useState('')
  const [credentials, setCredentials] = useState<HttpCredentialSummary[]>([])
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [newCredentialType, setNewCredentialType] = useState<HttpAuthOption>('bearer')
  const [curlOpen, setCurlOpen] = useState(false)

  // (Re)seed from the endpoint being edited each time the dialog opens.
  useEffect(() => {
    if (!open) return
    setName(endpoint?.name ?? '')
    setDescription(endpoint?.description ?? '')
    setMethod(endpoint?.method ?? 'GET')
    setUrl(endpoint?.url ?? '')
    setQuery(toPairs(endpoint?.query))
    setHeaders(toPairs(endpoint?.headers))
    setBodyMode(endpoint?.bodyMode ?? 'none')
    setBody(endpoint?.body ?? '')
    setConnectionId(endpoint?.connectionId ?? '')
    setCredentialId(endpoint?.credentialId ?? '')
    // Zero-auth is never the default: an unbound endpoint starts on whichever
    // mode can finish here — a connected integration when one exists,
    // otherwise a credential for the host.
    setAuthMode(endpoint?.credentialId ? 'generic' : endpoint?.connectionId ? 'predefined' : connections.length ? 'predefined' : 'generic')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, endpoint])

  useEffect(() => {
    if (!open) return
    fetch('/api/http-credentials?scope=bindable', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setCredentials(Array.isArray(data?.credentials) ? data.credentials : []))
      .catch(() => setCredentials([]))
  }, [open, credentialDialogOpen])

  const params = useMemo(
    () =>
      endpointParams({
        id: 'draft',
        name: name || 'draft',
        method,
        url,
        query: fromPairs(query),
        headers: fromPairs(headers),
        bodyMode,
        body,
      }),
    [name, method, url, query, headers, bodyMode, body],
  )

  const hasBody = method !== 'GET' && method !== 'HEAD'

  const save = () => {
    if (!name.trim()) {
      toast.error('Name the endpoint — the agent calls it by this name.')
      return
    }
    try {
      const parsed = new URL(url.replace(/\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/g, 'x'))
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('bad protocol')
    } catch {
      toast.error('Enter an absolute URL (https://api.example.com/…).')
      return
    }
    // External calls never go out unauthenticated — the endpoint must bind a
    // connected integration or a stored credential before it can be saved.
    if (authMode === 'predefined' && !connectionId) {
      toast.error('Pick a connected integration to authenticate with — or switch to a generic credential.')
      return
    }
    if (authMode === 'generic' && !credentialId) {
      toast.error('Set up a credential for this host — requests are never sent unauthenticated.')
      return
    }
    onSave({
      id: endpoint?.id ?? crypto.randomUUID(),
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      method,
      url: url.trim(),
      query: fromPairs(query),
      headers: fromPairs(headers),
      ...(hasBody && bodyMode === 'json' && body.trim() ? { bodyMode: 'json' as const, body } : {}),
      ...(authMode === 'generic' && credentialId ? { credentialId } : {}),
      ...(authMode === 'predefined' && connectionId ? { connectionId } : {}),
    })
    onOpenChange(false)
  }

  const fieldClass =
    'w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{endpoint ? 'Edit API endpoint' : 'Add API endpoint'}</DialogTitle>
          <DialogDescription>
            The agent gets this as a tool it can call. Wrap values the agent should fill in at call time in double
            braces — for example https://api.example.com/weather?city=&#123;&#123;city&#125;&#125;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setCurlOpen(true)}>
              <TerminalSquare className="mr-1.5 h-4 w-4" /> Import cURL
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="endpoint-name">Name</Label>
              <Input id="endpoint-name" value={name} placeholder="Get weather" onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <Label>Method</Label>
              <select className={fieldClass} value={method} onChange={(event) => setMethod(event.target.value as AgentHttpEndpoint['method'])}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="endpoint-description">What it does</Label>
            <Input
              id="endpoint-description"
              value={description}
              placeholder="Fetches the current weather for a city"
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">Shown to the agent — helps it pick the right tool.</p>
          </div>

          <div>
            <Label htmlFor="endpoint-url">URL</Label>
            <Input
              id="endpoint-url"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={url}
              placeholder="https://api.example.com/v1/resource"
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <div>
            <Label>Authentication</Label>
            <select
              className={fieldClass}
              value={authMode}
              onChange={(event) => {
                const mode = event.target.value as 'predefined' | 'generic'
                setAuthMode(mode)
                if (mode !== 'predefined') setConnectionId('')
                if (mode !== 'generic') setCredentialId('')
              }}
            >
              <option value="predefined">Predefined Credential Type</option>
              <option value="generic">Generic Credential Type</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              {authMode === 'predefined'
                ? 'Reuse a connected integration for authentication.'
                : 'Choose an auth method, then set up a reusable credential for this host.'}
            </p>
          </div>

          {authMode === 'predefined' && (
            <div>
              <Label>Predefined credential</Label>
              {connections.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                  No connected integrations yet. Connect one under Integrations, then it appears here.
                </p>
              ) : (
                <select className={fieldClass} value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
                  <option value="">Choose a connection…</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connection.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {authMode === 'generic' && (
            <div className="space-y-2">
              <div>
                <Label>Credential</Label>
                <div className="flex gap-2">
                  <select className={`${fieldClass} min-w-0 flex-1`} value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
                    <option value="">Choose a verified credential…</option>
                    {credentials.map((credential) => (
                      <option key={credential.id} value={credential.id}>
                        {credential.name} ({credential.allowedHost})
                      </option>
                    ))}
                  </select>
                  <select
                    className={`${fieldClass} w-auto`}
                    value=""
                    aria-label="Add a new credential"
                    onChange={(event) => {
                      if (!event.target.value) return
                      setNewCredentialType(event.target.value as HttpAuthOption)
                      setCredentialDialogOpen(true)
                    }}
                  >
                    <option value="">+ New…</option>
                    {HTTP_AUTH_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          <PairsEditor label="Query parameters" pairs={query} onChange={setQuery} keyPlaceholder="city" valuePlaceholder="{{city}}" />
          <PairsEditor label="Headers" pairs={headers} onChange={setHeaders} keyPlaceholder="accept" valuePlaceholder="application/json" />

          {hasBody && (
            <div>
              <Label>Body</Label>
              <select className={fieldClass} value={bodyMode} onChange={(event) => setBodyMode(event.target.value as 'none' | 'json')}>
                <option value="none">None</option>
                <option value="json">JSON</option>
              </select>
              {bodyMode === 'json' && (
                <Textarea
                  className="mt-1.5 min-h-24 font-mono text-xs"
                  value={body}
                  placeholder={'{ "city": "{{city}}" }'}
                  onChange={(event) => setBody(event.target.value)}
                />
              )}
            </div>
          )}

          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <p className="text-xs font-medium">Agent inputs</p>
            {params.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                None yet — the request is sent exactly as configured. Add &#123;&#123;placeholders&#125;&#125; for values the agent should choose.
              </p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {params.map((param) => (
                  <Badge key={param} variant="outline" className="text-[11px]">{param}</Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={save}>{endpoint ? 'Save endpoint' : 'Add endpoint'}</Button>
        </DialogFooter>
      </DialogContent>

      <HttpCredentialDialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
        requestUrl={url}
        requestMethod={method}
        initialAuthType={newCredentialType}
        editableUrl
        onSaved={(credential) => setCredentialId(credential.id)}
      />

      <ImportCurlDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={(parsed) => {
          if (parsed.method) setMethod(parsed.method)
          if (parsed.url) {
            try {
              const parsedUrl = new URL(parsed.url)
              const pairs: Pair[] = Array.from(parsedUrl.searchParams.entries()).map(([key, value]) => ({ key, value }))
              parsedUrl.search = ''
              setUrl(parsedUrl.toString())
              if (pairs.length) setQuery(pairs)
            } catch {
              setUrl(parsed.url)
            }
          }
          if (parsed.headers) {
            try {
              const record = JSON.parse(parsed.headers) as Record<string, string>
              setHeaders(Object.entries(record).map(([key, value]) => ({ key, value })))
            } catch {
              /* unparseable header JSON — leave headers as-is */
            }
          }
          if (parsed.body) {
            setBodyMode('json')
            setBody(parsed.body)
          }
        }}
      />
    </Dialog>
  )
}
