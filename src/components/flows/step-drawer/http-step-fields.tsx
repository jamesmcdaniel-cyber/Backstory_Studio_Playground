'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HTTP_AUTH_OPTIONS, type HttpAuthOption, HttpCredentialDialog, type HttpCredentialSummary } from '@/components/flows/http-credential-dialog'
import { ImportCurlDialog } from '@/components/flows/import-curl-dialog'
import { NodeOptions } from '@/components/flows/node-options'
import { PanelNotice } from '@/components/flows/panel-notice'
import { TokenTextEditor } from '@/components/flows/token-text-editor'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { type FlowContext } from '@/features/flows/context'
import { fileBindingOptions } from '@/lib/flows/datatree'
import { type FlowNode } from '@/lib/flows/graph'
import { type FieldIssue } from '@/lib/flows/issue-fields'
import { mcpStepSuggestion } from '@/lib/flows/mcp-step-suggestion'
import { type NodeOption } from '@/lib/flows/node-options'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { groupToolConnections } from '@/lib/flows/tool-presentation'
import { cn } from '@/lib/utils'
import { KeyRound, TerminalSquare } from 'lucide-react'
// The step-editor primitives, from the neutral module both this component and
// the drawer import — not from the drawer itself, which would be a cycle.
import {
  FieldIssues,
  FormFileFields,
  KeyValueJsonEditor,
  PerItemSection,
  cleanOptimize,
  fieldClass,
  labelClass,
  type TokenEditorPlumbing,
  type ToolCatalog,
} from './shared'

/**
 * Everything the HTTP step needs, in one place.
 *
 * Extracted from StepDrawer, where it was a 620-line JSX branch plus seven
 * `useState` hooks, two `useMemo`s, an effect, and two dialogs — all of them
 * used by nothing else, but declared 900 lines above the markup that used them
 * and 1,300 lines below the dialogs that closed over them. Moving the whole
 * concern here is what makes the drawer's remaining state readable: those seven
 * hooks were the largest single group in it.
 *
 * The dialogs come along because they are Radix portals — where they sit in the
 * tree does not affect where they render, and they close over this component's
 * credential state.
 */

type Props = {
  node: Extract<FlowNode, { type: 'http' }>
  onChange: (node: FlowNode) => void
  issueFor: (field: string) => FieldIssue[] | undefined
  previewCtx?: FlowContext
  toolCatalog: ToolCatalog
} & TokenEditorPlumbing

export function HttpStepFields({
  node,
  onChange,
  issueFor,
  previewCtx,
  toolCatalog,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: Props) {
  const uid = useId()
  const mcpSuggestion = useMemo(
    () => mcpStepSuggestion(node as { type: string; data: Record<string, unknown> }, groupToolConnections(toolCatalog).flatMap((group) => group.connections)),
    [node, toolCatalog],
  )
  const [httpCredentials, setHttpCredentials] = useState<HttpCredentialSummary[]>([])
  type CredentialResolverSummary = {
    id: string
    name: string
    authType: HttpAuthOption
    allowedHost: string
    status: 'active' | 'disabled'
    boundCredentialId: string | null
    ready: boolean
  }
  const [credentialResolvers, setCredentialResolvers] = useState<CredentialResolverSummary[]>([])
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [newCredentialType, setNewCredentialType] = useState<HttpAuthOption>('basic')
  const [curlDialogOpen, setCurlDialogOpen] = useState(false)
  const [reverifyingCredential, setReverifyingCredential] = useState(false)

  // HTTP auth: a two-way selector (Predefined / Generic) — zero-auth requests
  // are not offered; every HTTP step authenticates. The mode is derived from
  // what the node already binds, with a local override so a user can pick
  // "Generic" and see the auth-type sub-select before a credential exists.
  // Reset when the selected node changes.
  const [httpAuthMode, setHttpAuthMode] = useState<'predefined' | 'generic' | 'perUser'>('generic')
  // Predefined credentials reuse connected integrations. Only MCP-plane
  // connections carry a token the HTTP executor can inject, so filter to those.
  const predefinedConnections = useMemo(
    () => groupToolConnections(toolCatalog)
      .flatMap((group) => group.connections)
      .filter((connection) => parseFlowToolConnectionId(connection.id).plane === 'mcp'),
    [toolCatalog],
  )
  // Upstream data a multipart file field can be bound to — objects only, since
  // a file arrives as a file reference. Same source as the data menu, so the
  // picker and the chips always agree.
  const fileOptions = useMemo(() => fileBindingOptions(dataFields), [dataFields])
  // Bindable credentials and per-user resolvers for this workspace. Fetched
  // here rather than in the drawer: this component is mounted only for an HTTP
  // step, so the request happens exactly when it is needed instead of on every
  // node selection with an early return.
  useEffect(() => {
    Promise.all([
      fetch('/api/http-credentials?scope=bindable', { cache: 'no-store' }).then((response) => response.json()),
      fetch('/api/credential-resolvers', { cache: 'no-store' }).then((response) => response.json()),
    ])
      .then(([credentialData, resolverData]) => {
        if (credentialData?.success && Array.isArray(credentialData.credentials)) setHttpCredentials(credentialData.credentials)
        if (resolverData?.success && Array.isArray(resolverData.resolvers)) setCredentialResolvers(resolverData.resolvers)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    // An unbound step starts on whichever mode can actually finish here:
    // reuse a connected integration when one exists, otherwise set up a
    // credential for the host.
    setHttpAuthMode(
      node.data.connectionId ? 'predefined'
        : node.data.credentialResolverId ? 'perUser'
        : node.data.credentialId ? 'generic'
          : predefinedConnections.length ? 'predefined' : 'generic',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  return (
    <>
      <div className="space-y-5">
        {/* This step is really an MCP call, hand-built. Calling an MCP
            server over HTTP means a POST carrying a JSON-RPC envelope, with
            the tool name buried in a body field and the arguments written
            as JSON by hand. The Tool step is the same call as three
            controls, with the action picked from a list and the arguments
            rendered from the tool's own schema. */}
        {mcpSuggestion && (
          <PanelNotice
            action={
              <Button
              type="button"
              size="sm"
              onClick={() => onChange({
                id: node.id,
                type: 'tool',
                position: (node as { position?: unknown }).position,
                ...(node.disabled ? { disabled: true } : {}),
                data: {
                  ...(node.data.label ? { label: node.data.label } : {}),
                  connectionId: mcpSuggestion.connectionId,
                  toolName: mcpSuggestion.toolName ?? '',
                  args: mcpSuggestion.args ?? '{}',
                },
              } as unknown as FlowNode)}
            >
              Use a Tool step instead
              </Button>
            }
          >
            <span className="font-medium">This calls {mcpSuggestion.connectionName} over MCP.</span>{' '}
            A Tool step makes the same call without the JSON-RPC envelope — pick the action from a
            list, and its arguments come from the tool&apos;s own schema.
          </PanelNotice>
        )}
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setCurlDialogOpen(true)}>
            <TerminalSquare className="mr-1.5 h-4 w-4" /> Import cURL
          </Button>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-http-method`}>Method</label>
          <select
            id={`${uid}-http-method`}
            className={fieldClass}
            value={node.data.method}
            onChange={(e) => onChange({ ...node, data: { ...node.data, method: e.target.value as typeof node.data.method } })}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${uid}-http-url`}>URL</label>
          <input
            id={`${uid}-http-url`}
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={fieldClass}
            value={node.data.url}
            placeholder="https://api.example.com/v1/resource"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(event) => onChange({ ...node, data: { ...node.data, url: event.target.value } })}
            aria-label="Request URL"
          />
          <FieldIssues issues={issueFor('url')} />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${uid}-http-auth`}>Authentication</label>
          <select
            id={`${uid}-http-auth`}
            className={fieldClass}
            value={httpAuthMode}
            onChange={(event) => {
              const mode = event.target.value as 'predefined' | 'generic' | 'perUser'
              setHttpAuthMode(mode)
              onChange({
                ...node,
                data: {
                  ...node.data,
                  connectionId: mode === 'predefined' ? node.data.connectionId : undefined,
                  credentialId: mode === 'generic' ? node.data.credentialId : undefined,
                  credentialResolverId: mode === 'perUser' ? node.data.credentialResolverId : undefined,
                },
              })
            }}
          >
            <option value="predefined">Connected server (MCP)</option>
            <option value="generic">My credential</option>
            <option value="perUser">Each runner’s credential</option>
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {httpAuthMode === 'predefined'
              ? 'Reuse a connected MCP server’s token for authentication.'
              : httpAuthMode === 'perUser'
                ? 'Resolve the executing person’s explicit credential binding at run time.'
                : 'Choose an auth method, then set up your reusable credential for this host.'}
          </p>
          {/* The checker owns this message now — it knows which brand the
              URL points at and whether that integration is connected, so
              it says something more useful than a generic warning could. */}
          <FieldIssues issues={issueFor('httpAuth')} />
        </div>

        {httpAuthMode === 'predefined' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-http-connection`}>Connected server</label>
            {predefinedConnections.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No MCP servers with an injectable token are connected. App integrations (Slack, Salesforce, …)
                authenticate through Tool steps instead — for a raw HTTP call, add an MCP server under
                Integrations → MCP Servers, or use a manual credential.
              </p>
            ) : (
              <select
                id={`${uid}-http-connection`}
                className={fieldClass}
                value={node.data.connectionId ?? ''}
                onChange={(event) => onChange({ ...node, data: { ...node.data, connectionId: event.target.value || undefined, credentialId: undefined, credentialResolverId: undefined } })}
              >
                <option value="">Choose a connection…</option>
                {predefinedConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>{connection.name}</option>
                ))}
              </select>
            )}
          </div>
        )}

        {httpAuthMode === 'generic' && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-http-auth-type`}>Generic Auth Type</label>
            <select
              id={`${uid}-http-auth-type`}
              className={fieldClass}
              value={httpCredentials.find((credential) => credential.id === node.data.credentialId)?.authType ?? ''}
              onChange={(event) => {
                if (!event.target.value) return
                setNewCredentialType(event.target.value as HttpAuthOption)
                setCredentialDialogOpen(true)
              }}
            >
              <option value="">Select…</option>
              {HTTP_AUTH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        )}

        {httpAuthMode === 'generic' && (node.data.credentialId || httpCredentials.length > 0) && (
          <div>
            <label className={labelClass} htmlFor={`${uid}-http-credential`}>Credential</label>
            <div className="flex gap-2">
              <select
                id={`${uid}-http-credential`}
                className={`${fieldClass} min-w-0 flex-1`}
                value={node.data.credentialId ?? ''}
                onChange={(event) => onChange({
                  ...node,
                  data: { ...node.data, credentialId: event.target.value || undefined, connectionId: undefined, credentialResolverId: undefined },
                })}
              >
                <option value="">Choose a verified credential…</option>
                {httpCredentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {credential.name} · {credential.allowedHost}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setNewCredentialType(
                    (httpCredentials.find((credential) => credential.id === node.data.credentialId)?.authType || 'basic') as HttpAuthOption,
                  )
                  setCredentialDialogOpen(true)
                }}
              >
                <KeyRound className="mr-1.5 h-4 w-4" /> Set up new
              </Button>
            </div>
            {node.data.credentialId && (() => {
              const selected = httpCredentials.find((entry) => entry.id === node.data.credentialId)
              const flagged = selected?.status === 'error'
              return (
                <div className="mt-1.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className={cn('flex items-center gap-1.5 text-xs', flagged ? 'text-amber-700' : 'text-emerald-700')}>
                      <span className={cn('h-1.5 w-1.5 rounded-full', flagged ? 'bg-amber-500' : 'bg-emerald-500')} />
                      {flagged
                        ? 'This credential was rejected on a recent run.'
                        : 'Verified credential — secrets are encrypted and excluded from the flow.'}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={reverifyingCredential}
                      onClick={async () => {
                        if (!node.data.credentialId) return
                        setReverifyingCredential(true)
                        try {
                          const response = await fetch('/api/http-credentials', {
                            method: 'PATCH',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ id: node.data.credentialId, url: node.data.url, method: node.data.method }),
                          })
                          const data = await response.json().catch(() => ({}))
                          if (!response.ok) {
                            toast.error(data.error || 'The credential could not be verified.')
                            if (data.credential) setHttpCredentials((current) => current.map((entry) => entry.id === data.credential.id ? data.credential : entry))
                            return
                          }
                          toast.success('Credential re-verified.')
                          setHttpCredentials((current) => current.map((entry) => entry.id === data.credential.id ? data.credential : entry))
                        } catch {
                          toast.error('The credential could not be verified.')
                        } finally {
                          setReverifyingCredential(false)
                        }
                      }}
                    >
                      {reverifyingCredential ? 'Verifying…' : 'Re-verify'}
                    </Button>
                  </div>
                  {flagged && selected?.lastError && (
                    <p className="text-xs text-amber-700/80">{selected.lastError}</p>
                  )}
                  {selected && !selected.isSharedLegacy && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={async () => {
                        try {
                          const response = await fetch('/api/credential-resolvers', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                              action: 'create',
                              name: `${selected.name} · per-user`,
                              credentialId: selected.id,
                            }),
                          })
                          const data = await response.json().catch(() => ({}))
                          if (!response.ok) throw new Error(data.error || 'Could not create the per-user resolver.')
                          const resolver = data.resolver as CredentialResolverSummary
                          setCredentialResolvers((current) => [resolver, ...current.filter((entry) => entry.id !== resolver.id)])
                          setHttpAuthMode('perUser')
                          onChange({
                            ...node,
                            data: {
                              ...node.data,
                              credentialResolverId: resolver.id,
                              credentialId: undefined,
                              connectionId: undefined,
                            },
                          })
                          toast.success('Per-user credential resolution is enabled.')
                        } catch (error) {
                          toast.error(error instanceof Error ? error.message : 'Could not create the per-user resolver.')
                        }
                      }}
                    >
                      Make per-user
                    </Button>
                  )}
                </div>
              )
            })()}
          </div>
        )}

        {httpAuthMode === 'perUser' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-credential-resolver`}>Credential resolver</label>
              <select
                id={`${uid}-credential-resolver`}
                className={fieldClass}
                value={node.data.credentialResolverId ?? ''}
                onChange={(event) => onChange({
                  ...node,
                  data: {
                    ...node.data,
                    credentialResolverId: event.target.value || undefined,
                    credentialId: undefined,
                    connectionId: undefined,
                  },
                })}
              >
                <option value="">Choose a per-user resolver…</option>
                {credentialResolvers.filter((resolver) => resolver.status === 'active').map((resolver) => (
                  <option key={resolver.id} value={resolver.id}>
                    {resolver.name} · {resolver.authType} · {resolver.allowedHost}{resolver.ready ? '' : ' · connect yours'}
                  </option>
                ))}
              </select>
            </div>
            {node.data.credentialResolverId && (() => {
              const resolver = credentialResolvers.find((entry) => entry.id === node.data.credentialResolverId)
              if (!resolver) return null
              const matches = httpCredentials.filter((credential) =>
                credential.userId && credential.authType === resolver.authType && credential.allowedHost === resolver.allowedHost)
              return (
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs font-medium">My binding</p>
                  <div className="mt-2 flex gap-2">
                    <select
                      className={`${fieldClass} min-w-0 flex-1`}
                      value={resolver.boundCredentialId ?? ''}
                      onChange={async (event) => {
                        const credentialId = event.target.value
                        if (!credentialId) return
                        try {
                          const response = await fetch('/api/credential-resolvers', {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ action: 'bind', resolverId: resolver.id, credentialId }),
                          })
                          const data = await response.json().catch(() => ({}))
                          if (!response.ok) throw new Error(data.error || 'Could not bind the credential.')
                          setCredentialResolvers((current) => current.map((entry) =>
                            entry.id === resolver.id ? { ...entry, boundCredentialId: credentialId, ready: true } : entry))
                          toast.success('Your credential is connected to this workflow resolver.')
                        } catch (error) {
                          toast.error(error instanceof Error ? error.message : 'Could not bind the credential.')
                        }
                      }}
                    >
                      <option value="">Connect my credential…</option>
                      {matches.map((credential) => <option key={credential.id} value={credential.id}>{credential.name}</option>)}
                    </select>
                    <Button type="button" variant="outline" onClick={() => {
                      setNewCredentialType(resolver.authType)
                      setCredentialDialogOpen(true)
                    }}>
                      <KeyRound className="mr-1.5 h-4 w-4" /> New
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {resolver.ready
                      ? 'Ready for you. Other runners must connect their own matching credential.'
                      : matches.length
                        ? 'Choose which of your matching credentials this workflow may use.'
                        : `Create a ${resolver.authType} credential for ${resolver.allowedHost}.`}
                  </p>
                </div>
              )
            })()}
            {credentialResolvers.length === 0 && (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                No shared resolver exists yet. Select one of your credentials and choose “Make per-user” below.
              </p>
            )}
          </div>
        )}

        <div className="space-y-3 border-t pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Send Query Parameters</p>
              <p className="text-xs text-muted-foreground">Add JSON key/value parameters to the URL.</p>
            </div>
            <Switch
              checked={node.data.sendQuery ?? Boolean(node.data.query?.trim())}
              onCheckedChange={(sendQuery) => onChange({ ...node, data: { ...node.data, sendQuery } })}
              aria-label="Send Query Parameters"
            />
          </div>
          {(node.data.sendQuery ?? Boolean(node.data.query?.trim())) && (
            <KeyValueJsonEditor
              label="Query parameters"
              value={node.data.query}
              keyPlaceholder="account_id"
              valuePlaceholder="Value or input data"
              helper="Stored as a JSON object. Arrays become repeated query parameters."
              onChange={(query) => onChange({ ...node, data: { ...node.data, query } })}
              labelCtx={labelCtx}
              editorKey="http.query"
              registerEditor={registerEditor}
              focusEditor={focusEditor}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
          )}
        </div>

        <div className="space-y-3 border-t pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Send Headers</p>
              <p className="text-xs text-muted-foreground">Add non-secret request headers as JSON.</p>
            </div>
            <Switch
              checked={node.data.sendHeaders ?? Boolean(node.data.headers?.trim())}
              onCheckedChange={(sendHeaders) => onChange({ ...node, data: { ...node.data, sendHeaders } })}
              aria-label="Send Headers"
            />
          </div>
          {(node.data.sendHeaders ?? Boolean(node.data.headers?.trim())) && (
            <KeyValueJsonEditor
              label="Headers"
              value={node.data.headers}
              keyPlaceholder="Content-Language"
              valuePlaceholder="en-US"
              helper="Stored as a JSON object. Put reusable secrets in Authentication, not here."
              onChange={(headers) => onChange({ ...node, data: { ...node.data, headers } })}
              labelCtx={labelCtx}
              editorKey="http.headers"
              registerEditor={registerEditor}
              focusEditor={focusEditor}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
          )}
        </div>

        <div className="space-y-3 border-t pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Send Body</p>
              <p className="text-xs text-muted-foreground">Configure the request payload.</p>
            </div>
            <Switch
              checked={node.data.sendBody ?? Boolean(node.data.body?.trim())}
              disabled={node.data.method === 'GET' || node.data.method === 'HEAD'}
              onCheckedChange={(sendBody) => onChange({ ...node, data: { ...node.data, sendBody } })}
              aria-label="Send Body"
            />
          </div>
          {(node.data.method === 'GET' || node.data.method === 'HEAD') && (
            <p className="text-xs text-amber-700">HTTP {node.data.method} requests do not send a body.</p>
          )}
          {(node.data.sendBody ?? Boolean(node.data.body?.trim())) && node.data.method !== 'GET' && node.data.method !== 'HEAD' && (
            <>
              <div>
                <label className={labelClass} htmlFor={`${uid}-http-body-mode`}>Body Content Type</label>
                <select
                  id={`${uid}-http-body-mode`}
                  className={fieldClass}
                  value={node.data.bodyMode === 'text' ? 'raw' : (node.data.bodyMode ?? 'json')}
                  onChange={(event) => onChange({
                    ...node,
                    data: { ...node.data, bodyMode: event.target.value as Exclude<typeof node.data.bodyMode, 'text' | undefined> },
                  })}
                >
                  <option value="json">JSON</option>
                  <option value="raw">Raw</option>
                  <option value="graphql">GraphQL</option>
                  <option value="form-urlencoded">Form URL Encoded</option>
                  <option value="form-data">Form-Data (Multipart)</option>
                </select>
              </div>
              {node.data.bodyMode === 'form-urlencoded' || node.data.bodyMode === 'form-data' ? (
                <>
                <KeyValueJsonEditor
                  label="Body fields"
                  value={node.data.body}
                  keyPlaceholder="field"
                  valuePlaceholder="Value or input data"
                  helper={node.data.bodyMode === 'form-data'
                    ? 'These fields are sent as multipart/form-data text parts. Attach files below.'
                    : 'These JSON fields are encoded as application/x-www-form-urlencoded.'}
                  onChange={(body) => onChange({ ...node, data: { ...node.data, body } })}
                  labelCtx={labelCtx}
                  editorKey="http.body"
                  registerEditor={registerEditor}
                  focusEditor={focusEditor}
                  blockActive={blockActive}
                  unblockActive={unblockActive}
                />
                {node.data.bodyMode === 'form-data' && (
                  <FormFileFields
                    bindings={node.data.formFiles ?? []}
                    options={fileOptions}
                    onChange={(formFiles) => onChange({ ...node, data: { ...node.data, formFiles } })}
                  />
                )}
                </>
              ) : (
                <div>
                  {(node.data.bodyMode === 'raw' || node.data.bodyMode === 'text') && (
                    <div className="mb-3">
                      <label className={labelClass} htmlFor={`${uid}-http-content-type`}>Content type</label>
                      <input
                        id={`${uid}-http-content-type`}
                        className={fieldClass}
                        value={node.data.contentType ?? ''}
                        placeholder="text/plain"
                        onChange={(event) => onChange({ ...node, data: { ...node.data, contentType: event.target.value || undefined } })}
                      />
                    </div>
                  )}
                  <label className={labelClass}>
                    {node.data.bodyMode === 'graphql' ? 'GraphQL query or JSON request' : node.data.bodyMode === 'raw' || node.data.bodyMode === 'text' ? 'Raw body' : 'JSON body'}
                  </label>
                  <TokenTextEditor
                    ref={registerEditor('http.body')}
            previewCtx={previewCtx}
                    multiline
                    rows={8}
                    className="font-mono text-xs"
                    value={node.data.body ?? ''}
                    labelCtx={labelCtx}
                    placeholder={
                      node.data.bodyMode === 'graphql'
                        ? 'query GetAccount { account { id name } }'
                        : node.data.bodyMode === 'raw' || node.data.bodyMode === 'text'
                          ? 'Raw request content'
                          : '{\n  "name": "Use a value from Input"\n}'
                    }
                    onFocus={focusEditor('http.body')}
                    onChange={(body) => onChange({ ...node, data: { ...node.data, body: body || undefined } })}
                    ariaLabel="Request body"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* One Options control, holding everything optional. It replaced
            two differently-named <details> and a separate "Advanced
            parameters" panel: a step with a quarter of n8n's configuration
            read as the busier one because its optional settings were behind
            four lids of three different shapes. The nested editors below are
            unchanged — the collection only decides whether they exist. */}
        <NodeOptions
          node={node}
          onChange={onChange}
          renderCustom={(option: NodeOption) => {
            if (option.key === 'pagination') {
              return (
                <div className="space-y-3">
          <div className="mt-3 space-y-3">
            <select
              className={fieldClass}
              value={node.data.pagination?.mode ?? 'off'}
              onChange={(e) => {
                const mode = e.target.value
                onChange({ ...node, data: { ...node.data, pagination: mode === 'off' ? undefined : { ...(node.data.pagination ?? {}), mode: mode as 'updateParam' | 'nextUrl' } } })
              }}
            >
              <option value="off">Off — one request</option>
              <option value="updateParam">Increment a page/offset parameter</option>
              <option value="nextUrl">Follow a next-page URL in the response</option>
            </select>
            {node.data.pagination && (
              <div className="grid grid-cols-2 gap-2">
                {node.data.pagination.mode === 'updateParam' && (
                  <>
                    <label className="text-xs">Parameter<input className={fieldClass} placeholder="page" value={node.data.pagination.param ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, param: e.target.value || undefined } } })} /></label>
                    <label className="text-xs">Start at<input type="number" className={fieldClass} placeholder="1" value={node.data.pagination.start ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, start: e.target.value === '' ? undefined : Number(e.target.value) } } })} /></label>
                  </>
                )}
                {node.data.pagination.mode === 'nextUrl' && (
                  <label className="col-span-2 text-xs">Next-URL field (path in response)<input className={fieldClass} placeholder="links.next" value={node.data.pagination.nextUrlPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, nextUrlPath: e.target.value || undefined } } })} /></label>
                )}
                <label className="text-xs">List field (path)<input className={fieldClass} placeholder="data" value={node.data.pagination.itemsPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, itemsPath: e.target.value || undefined } } })} /></label>
                <label className="text-xs">Max pages<input type="number" min={1} max={50} className={fieldClass} placeholder="5" value={node.data.pagination.maxPages ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, maxPages: e.target.value === '' ? undefined : Math.max(1, Math.min(50, Number(e.target.value))) } } })} /></label>
                <label className="text-xs">Stop when<select className={fieldClass} value={node.data.pagination.completeWhen ?? 'emptyPage'} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completeWhen: e.target.value as 'emptyPage' | 'statusCode' | 'pathMissing' } } })}>
                  <option value="emptyPage">A page comes back empty</option>
                  <option value="statusCode">The response has a certain status</option>
                  <option value="pathMissing">A field in the response says there is no more</option>
                </select></label>
                {node.data.pagination.completeWhen === 'statusCode' && (
                  <label className="text-xs">Stop on these statuses<input className={fieldClass} placeholder="404, 204" value={node.data.pagination.completeStatusCodes ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completeStatusCodes: e.target.value || undefined } } })} /></label>
                )}
                {node.data.pagination.completeWhen === 'pathMissing' && (
                  <label className="text-xs">Field that says &ldquo;more pages&rdquo;<input className={fieldClass} placeholder="has_more" value={node.data.pagination.completePath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completePath: e.target.value || undefined } } })} /></label>
                )}
                <label className="text-xs">Pause between pages (ms)<input type="number" min={0} max={10000} className={fieldClass} placeholder="0" value={node.data.pagination.intervalMs ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, intervalMs: e.target.value === '' ? undefined : Math.max(0, Math.min(10000, Number(e.target.value))) } } })} /></label>
              </div>
            )}
            {node.data.pagination && <p className="text-xs text-muted-foreground">Items from every page are combined into one list in the output.</p>}
          </div>
                </div>
              )
            }
            if (option.key === 'optimizeForAi') {
              return (
                <div className="grid grid-cols-2 gap-2">
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="col-span-2 text-xs">Keep only this part (path)<input className={fieldClass} placeholder="data" value={node.data.optimizeForAi?.dataPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, dataPath: e.target.value || undefined }) } })} /></label>
            <label className="col-span-2 text-xs">Keep only these fields (comma-separated)<input className={fieldClass} placeholder="id, name, email" value={(node.data.optimizeForAi?.fields ?? []).join(', ')} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) } })} /></label>
            <label className="text-xs">Max items<input type="number" min={1} className={fieldClass} placeholder="No limit" value={node.data.optimizeForAi?.maxItems ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, maxItems: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) }) } })} /></label>
          </div>
                </div>
              )
            }
            if (option.key === 'perItem') {
              return (
                <PerItemSection
                  node={node}
                  onChange={onChange}
                  dataFields={dataFields}
                  labelCtx={labelCtx}
                  registerEditor={registerEditor}
                  focusEditor={focusEditor}
                  insertToken={insertToken}
                />
              )
            }
            return null
          }}
        />

        <p className="text-xs text-muted-foreground">Calls a public HTTPS endpoint. The raw status, response headers, parsed body, and response text appear in Output.</p>
      </div>
      <HttpCredentialDialog
        open={credentialDialogOpen}
        onOpenChange={setCredentialDialogOpen}
        requestUrl={node.data.url}
        requestMethod={node.data.method}
        initialAuthType={newCredentialType}
        onSaved={async (credential) => {
          setHttpCredentials((current) => [
            credential,
            ...current.filter((entry) => entry.id !== credential.id),
          ])
          if (httpAuthMode === 'perUser' && node.data.credentialResolverId) {
            try {
              const response = await fetch('/api/credential-resolvers', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'bind', resolverId: node.data.credentialResolverId, credentialId: credential.id }),
              })
              const data = await response.json().catch(() => ({}))
              if (!response.ok) throw new Error(data.error || 'The new credential does not match this resolver.')
              setCredentialResolvers((current) => current.map((entry) =>
                entry.id === node.data.credentialResolverId
                  ? { ...entry, boundCredentialId: credential.id, ready: true }
                  : entry))
              toast.success('Your new credential is connected to this workflow resolver.')
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Could not connect the new credential.')
            }
            return
          }
          onChange({ ...node, data: { ...node.data, credentialId: credential.id, connectionId: undefined, credentialResolverId: undefined } })
        }}
      />
      <ImportCurlDialog
        open={curlDialogOpen}
        onOpenChange={setCurlDialogOpen}
        onImport={(parsed) => onChange({
          ...node,
          data: {
            ...node.data,
            ...(parsed.method ? { method: parsed.method } : {}),
            ...(parsed.url ? { url: parsed.url } : {}),
            ...(parsed.headers ? { headers: parsed.headers, sendHeaders: true } : {}),
            ...(parsed.body !== undefined ? { body: parsed.body, sendBody: true } : {}),
            ...(parsed.bodyMode ? { bodyMode: parsed.bodyMode } : {}),
            ...(parsed.followRedirects ? { followRedirects: true } : {}),
          },
        })}
      />
    </>
  )
}
