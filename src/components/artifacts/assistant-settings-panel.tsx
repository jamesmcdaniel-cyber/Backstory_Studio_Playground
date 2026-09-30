'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { IntegrationLogo } from '@/components/integrations/integration-logo'

type ToolOption = { key: string; ids: string[]; name: string; slug: string | null; kind: 'integration' | 'builtin'; tools: number; source: 'agent' | 'always' | 'optional'; enabled: boolean }
type Setup = { config: { instructions: string; toolConnectionIds: string[] }; agent: { id: string; title: string } | null; tools: ToolOption[] }

const SOURCE_NOTE: Record<ToolOption['source'], string> = {
  agent: 'From the agent',
  always: 'Always available',
  optional: '',
}

/**
 * The assistant's mini config: standing instructions it follows on every
 * message, and the workspace's connected tools it may use beyond the agent's
 * own. Saved on the artifact, applied to every assistant run from it.
 */
export function AssistantSettingsPanel({ artifactId, canEdit }: { artifactId: string; canEdit: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [instructions, setInstructions] = useState('')
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/artifacts/${artifactId}/assistant`, { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'The settings could not be loaded.')
        return data as Setup
      })
      .then((data) => {
        if (cancelled) return
        setSetup(data)
        setInstructions(data.config.instructions)
        setEnabled(new Set(data.config.toolConnectionIds))
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [artifactId])

  const dirty = setup !== null && (instructions.trim() !== setup.config.instructions || [...enabled].sort().join(',') !== [...setup.config.toolConnectionIds].sort().join(','))

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch(`/api/artifacts/${artifactId}/assistant`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions, toolConnectionIds: [...enabled] }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The settings could not be saved.')
      setSetup(data as Setup)
      setInstructions((data as Setup).config.instructions)
      setEnabled(new Set((data as Setup).config.toolConnectionIds))
      toast.success('Assistant settings saved — they apply to the next message.')
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (error) return <p className="px-4 py-3 text-sm text-red-600">{error}</p>
  if (!setup) return <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading settings…</div>

  const toggle = (tool: ToolOption) => setEnabled((current) => {
    const next = new Set(current)
    const on = tool.ids.some((id) => next.has(id))
    for (const id of tool.ids) { if (on) next.delete(id); else next.add(id) }
    return next
  })
  const icon = (tool: ToolOption) => tool.slug
    ? <IntegrationLogo slug={tool.slug} name={tool.name} className="h-5 w-5" />
    : <span className="flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground"><Wrench className="h-3 w-3" aria-hidden /></span>
  const section = (kind: ToolOption['kind']) => {
    const rows = setup.tools.filter((tool) => tool.kind === kind)
    const optional = rows.filter((tool) => tool.source === 'optional')
    const fixed = rows.filter((tool) => tool.source !== 'optional')
    return (
      <>
        {optional.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {optional.map((tool) => {
              const on = tool.ids.some((id) => enabled.has(id))
              return (
                <li key={tool.key}>
                  <label htmlFor={`assistant-tool-${tool.key}`} aria-label={`Let the assistant use ${tool.name}`} className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm', on ? 'border-horizon-300 bg-horizon-50' : 'border-border hover:bg-muted/50', !canEdit && 'cursor-not-allowed opacity-60')}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      {icon(tool)}
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{tool.name}</span>
                        <span className="block text-xs text-muted-foreground">{tool.tools} tool{tool.tools === 1 ? '' : 's'}</span>
                      </span>
                    </span>
                    <input id={`assistant-tool-${tool.key}`} type="checkbox" checked={on} disabled={!canEdit} onChange={() => toggle(tool)} className="h-4 w-4 accent-horizon-600" />
                  </label>
                </li>
              )
            })}
          </ul>
        )}
        {fixed.length > 0 && (
          <ul className="mt-2 space-y-1">
            {fixed.map((tool) => (
              <li key={tool.key} className="flex items-center justify-between gap-3 px-1 py-0.5 text-xs text-muted-foreground">
                <span className="flex min-w-0 items-center gap-2 truncate">{icon(tool)}<span className="truncate text-foreground/80">{tool.name}</span></span>
                <span className="flex shrink-0 items-center gap-1"><Check className="h-3.5 w-3.5 text-green-600" aria-hidden />{SOURCE_NOTE[tool.source]}</span>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }
  const hasIntegrations = setup.tools.some((tool) => tool.kind === 'integration')
  const hasBuiltins = setup.tools.some((tool) => tool.kind === 'builtin')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-3">
        <section>
          <label htmlFor="assistant-instructions" className="text-sm font-medium">Instructions</label>
          <p className="mt-0.5 text-xs text-muted-foreground">Followed on every message about this artifact — tone, audience, what to always include or never change.</p>
          <textarea
            id="assistant-instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            onKeyDown={indentOnTab}
            disabled={!canEdit}
            rows={5}
            maxLength={4000}
            placeholder="e.g. Write for a CFO. Keep the Summary tab to four findings. Never change the brand colors."
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </section>

        <section>
          <p className="text-sm font-medium">Integrations</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The assistant always has {setup.agent ? <>the tools of <Link href={`/agents?agent=${setup.agent.id}`} className="font-medium text-horizon-700 hover:underline">{setup.agent.title}</Link></> : "the agent's tools"}. Turn on your other connected integrations. Only working connections are listed.
          </p>
          {hasIntegrations ? section('integration') : (
            <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No connected integrations yet. <Link href="/integrations" className="font-medium text-horizon-700 hover:underline">Connect one</Link> and it appears here.
            </p>
          )}
        </section>

        {hasBuiltins && (
          <section>
            <p className="text-sm font-medium">Built-in tools</p>
            {section('builtin')}
          </section>
        )}
      </div>
      {canEdit && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <Button size="sm" variant="outline" disabled={!dirty || saving} onClick={() => { setInstructions(setup.config.instructions); setEnabled(new Set(setup.config.toolConnectionIds)) }}>Reset</Button>
          <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}Save</Button>
        </div>
      )}
    </div>
  )
}
