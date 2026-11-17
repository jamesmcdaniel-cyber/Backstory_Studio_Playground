'use client'

import { useEffect, useState } from 'react'
import { ArrowLeft, Database, KeyRound, Lock, ShieldCheck, Ticket, UserRound } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { HttpCredentialSummary } from '@/components/flows/http-credential-dialog'
import {
  API_CREDENTIAL_KINDS,
  EMPTY_API_CREDENTIAL_DRAFT,
  addressPlaceholder,
  buildApiCredentialPayload,
  defaultCredentialName,
  parseAddress,
  type ApiCredentialDraft,
  type ApiCredentialKind,
} from '@/components/integrations/api-credential-presets'

/**
 * "Connect an API" — save an API key, a bearer/JWT token, a client ID and
 * secret, a username and password, or a Snowflake/Databricks login, so flows
 * and agents can call that API without a Nango integration.
 *
 * A front door over the ordinary HTTP credential store (see
 * api-credential-presets.ts): the saved row belongs to the person who saved it,
 * is encrypted, is locked to the API's host, and has already worked once —
 * saving makes one live request and refuses credentials the API rejects.
 */

const KIND_ICON: Record<ApiCredentialKind, typeof KeyRound> = {
  api_key: KeyRound,
  bearer: Ticket,
  client_credentials: Lock,
  basic: UserRound,
  snowflake: Database,
  databricks: Database,
}

const fieldClass = 'h-10'

function Field({
  id,
  label,
  hint,
  children,
  className,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function TextField({
  id,
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  secret?: boolean
}) {
  return (
    <Input
      id={id}
      type={secret ? 'password' : 'text'}
      // Chrome ignores "off" and fills saved site passwords into a lone
      // password input; "new-password" is the value it respects.
      autoComplete={secret ? 'new-password' : 'off'}
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={fieldClass}
    />
  )
}

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              value === option.value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-foreground hover:bg-accent',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ApiCredentialDialog({
  open,
  onOpenChange,
  onSaved,
  initialKind,
  lockKind = false,
  onAdvanced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (credential: HttpCredentialSummary) => void
  /** Open straight on this kind's form instead of the chooser. */
  initialKind?: ApiCredentialKind
  /** Hide the way back to the chooser — used by the Snowflake/Databricks cards. */
  lockKind?: boolean
  /** Hand off to the full credential form (every auth scheme, external secrets). */
  onAdvanced?: () => void
}) {
  const [kind, setKind] = useState<ApiCredentialKind | null>(initialKind ?? null)
  const [draft, setDraft] = useState<Omit<ApiCredentialDraft, 'kind'>>(EMPTY_API_CREDENTIAL_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every open starts clean: a half-typed secret from last time must not be
  // sitting in the form for whoever opens it next.
  useEffect(() => {
    if (!open) return
    setKind(initialKind ?? null)
    setDraft(EMPTY_API_CREDENTIAL_DRAFT)
    setError(null)
  }, [initialKind, open])

  const set = <K extends keyof typeof draft>(key: K) => (value: (typeof draft)[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  const host = parseAddress(draft.address)?.hostname ?? ''
  const kindMeta = API_CREDENTIAL_KINDS.find((entry) => entry.kind === kind)

  const save = async () => {
    if (!kind) return
    const built = buildApiCredentialPayload({ ...draft, kind })
    if (!built.ok) {
      setError(built.error)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/http-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data?.credential) {
        setError(data?.error || 'The API could not verify these credentials.')
        return
      }
      toast.success(`${built.payload.name} verified and saved.`)
      onSaved(data.credential as HttpCredentialSummary)
      onOpenChange(false)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  const isWarehouse = kind === 'snowflake' || kind === 'databricks'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{kindMeta && lockKind ? `Connect ${kindMeta.label}` : kindMeta ? `Connect with ${kindMeta.label.toLowerCase()}` : 'Connect an API'}</DialogTitle>
          <DialogDescription>
            {kind === 'snowflake'
              ? 'Agents and flows query Snowflake with this login. It is saved to you, encrypted, and used only on your Snowflake account.'
              : kind === 'databricks'
                ? 'Agents and flows query Databricks with this login. It is saved to you, encrypted, and used only on your Databricks workspace.'
                : 'Save credentials once, then call this API from HTTP steps and agents — no app integration needed.'}
          </DialogDescription>
        </DialogHeader>

        {!kind ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">What did the API give you?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {API_CREDENTIAL_KINDS.map((entry) => {
                const Icon = KIND_ICON[entry.kind]
                return (
                  <button
                    key={entry.kind}
                    type="button"
                    onClick={() => setKind(entry.kind)}
                    className="flex items-start gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="block text-sm font-medium">{entry.label}</span>
                      <span className="block text-xs text-muted-foreground">{entry.description}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            {onAdvanced && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  onOpenChange(false)
                  onAdvanced()
                }}
              >
                Something else? Use the advanced form (OAuth1, digest, custom headers, external secrets).
              </button>
            )}
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            {!lockKind && (
              <button
                type="button"
                onClick={() => setKind(null)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" /> Choose a different type
              </button>
            )}

            <Field
              id="api-address"
              label={kind === 'snowflake' ? 'Snowflake account address' : kind === 'databricks' ? 'Databricks workspace address' : 'API address'}
              hint={
                isWarehouse
                  ? undefined
                  : 'The base URL or any endpoint on it. We make one GET request here to check the credentials work, and they are only ever sent to this host.'
              }
            >
              <TextField id="api-address" value={draft.address} onChange={set('address')} placeholder={addressPlaceholder(kind)} />
            </Field>

            {kind === 'api_key' && (
              <>
                <Choice
                  label="Where does the key go?"
                  value={draft.keyPlacement}
                  options={[
                    { value: 'header', label: 'In a header' },
                    { value: 'query', label: 'In the URL' },
                  ]}
                  onChange={set('keyPlacement')}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="api-key-name" label={draft.keyPlacement === 'header' ? 'Header name' : 'Parameter name'}>
                    <TextField id="api-key-name" value={draft.keyName} onChange={set('keyName')} placeholder={draft.keyPlacement === 'header' ? 'X-API-Key' : 'api_key'} />
                  </Field>
                  <Field id="api-key-value" label="API key">
                    <TextField id="api-key-value" value={draft.keyValue} onChange={set('keyValue')} secret />
                  </Field>
                </div>
              </>
            )}

            {kind === 'bearer' && (
              <Field id="api-token" label="Token" hint="A JWT or any other bearer token. It is sent as “Authorization: Bearer …” — paste it with or without the word Bearer.">
                <TextField id="api-token" value={draft.token} onChange={set('token')} placeholder="eyJhbGciOi…" secret />
              </Field>
            )}

            {kind === 'basic' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="api-username" label="Username">
                  <TextField id="api-username" value={draft.username} onChange={set('username')} />
                </Field>
                <Field id="api-password" label="Password">
                  <TextField id="api-password" value={draft.password} onChange={set('password')} secret />
                </Field>
              </div>
            )}

            {kind === 'client_credentials' && (
              <Choice
                label="How does the API take them?"
                value={draft.clientMode}
                options={[
                  { value: 'oauth', label: 'Exchange for a token' },
                  { value: 'basic', label: 'As Basic auth' },
                  { value: 'headers', label: 'As two headers' },
                ]}
                onChange={set('clientMode')}
              />
            )}

            {kind === 'databricks' && (
              <Choice
                label="Sign in with"
                value={draft.databricksMode}
                options={[
                  { value: 'pat', label: 'Personal access token' },
                  { value: 'service_principal', label: 'Service principal' },
                ]}
                onChange={set('databricksMode')}
              />
            )}

            {kind === 'snowflake' && (
              <Choice
                label="Sign in with"
                value={draft.snowflakeMode}
                options={[
                  { value: 'pat', label: 'Programmatic access token' },
                  { value: 'keypair', label: 'Key pair' },
                ]}
                onChange={set('snowflakeMode')}
              />
            )}

            {((kind === 'snowflake' && draft.snowflakeMode === 'pat') || (kind === 'databricks' && draft.databricksMode === 'pat')) && (
              <Field
                id="api-warehouse-token"
                label={kind === 'snowflake' ? 'Programmatic access token' : 'Personal access token'}
                hint={kind === 'snowflake' ? 'Create one in Snowsight under your profile → Programmatic access tokens.' : 'Create one in Databricks under Settings → Developer → Access tokens.'}
              >
                <TextField id="api-warehouse-token" value={draft.token} onChange={set('token')} placeholder={kind === 'databricks' ? 'dapi…' : undefined} secret />
              </Field>
            )}

            {kind === 'snowflake' && draft.snowflakeMode === 'keypair' && (
              <>
                <Field id="api-snowflake-user" label="Snowflake user">
                  <TextField id="api-snowflake-user" value={draft.snowflakeUser} onChange={set('snowflakeUser')} placeholder="BACKSTORY_SVC" />
                </Field>
                <Field id="api-snowflake-key" label="Private key (PEM)" hint="Stays encrypted here and signs a short-lived token for each request — it is never sent to Snowflake.">
                  <Textarea
                    id="api-snowflake-key"
                    rows={5}
                    spellCheck={false}
                    autoComplete="off"
                    value={draft.privateKey}
                    onChange={(event) => set('privateKey')(event.target.value)}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field id="api-snowflake-passphrase" label="Key passphrase (encrypted keys only)">
                  <TextField id="api-snowflake-passphrase" value={draft.passphrase} onChange={set('passphrase')} secret />
                </Field>
              </>
            )}

            {(kind === 'client_credentials' || (kind === 'databricks' && draft.databricksMode === 'service_principal')) && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="api-client-id" label="Client ID">
                  <TextField id="api-client-id" value={draft.clientId} onChange={set('clientId')} />
                </Field>
                <Field id="api-client-secret" label="Client secret">
                  <TextField id="api-client-secret" value={draft.clientSecret} onChange={set('clientSecret')} secret />
                </Field>
              </div>
            )}

            {kind === 'client_credentials' && draft.clientMode === 'oauth' && (
              <>
                <Field id="api-token-url" label="Token URL" hint="Where the client ID and secret are exchanged for an access token. A fresh token is fetched automatically when one expires.">
                  <TextField id="api-token-url" value={draft.tokenUrl} onChange={set('tokenUrl')} placeholder="https://auth.example.com/oauth/token" />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="api-scope" label="Scopes (optional)">
                    <TextField id="api-scope" value={draft.scope} onChange={set('scope')} placeholder="read write" />
                  </Field>
                  <Field id="api-audience" label="Audience (optional)">
                    <TextField id="api-audience" value={draft.audience} onChange={set('audience')} />
                  </Field>
                </div>
              </>
            )}

            {kind === 'client_credentials' && draft.clientMode === 'headers' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="api-client-id-header" label="Client ID header">
                  <TextField id="api-client-id-header" value={draft.clientIdHeader} onChange={set('clientIdHeader')} />
                </Field>
                <Field id="api-client-secret-header" label="Client secret header">
                  <TextField id="api-client-secret-header" value={draft.clientSecretHeader} onChange={set('clientSecretHeader')} />
                </Field>
              </div>
            )}

            <Field id="api-name" label="Name">
              <TextField id="api-name" value={draft.name} onChange={set('name')} placeholder={defaultCredentialName(kind, draft.address) || 'Production API'} />
            </Field>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Encrypted, saved to you, and only ever sent to <strong className="text-foreground">{host || 'this API’s host'}</strong>. Rotate or remove it any time from Credentials.
              </span>
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                {saving ? 'Verifying…' : 'Verify & save'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
