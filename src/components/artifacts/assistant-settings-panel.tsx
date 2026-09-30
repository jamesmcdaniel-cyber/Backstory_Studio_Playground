'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Loader2, Plug } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type ToolOption = { id: string; name: string; tools: number; source: 'agent' | 'always' | 'optional'; enabled: boolean; error?: string }
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

  const optional = setup.tools.filter((tool) => tool.source === 'optional')
  const fixed = setup.tools.filter((tool) => tool.source !== 'optional')

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-3">
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
          <p className="text-sm font-medium">Tools</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The assistant always has {setup.agent ? <>the tools of <Link href={`/agents?agent=${setup.agent.id}`} className="font-medium text-horizon-700 hover:underline">{setup.agent.title}</Link></> : "the agent's tools"}. Turn on other integrations you've connected.
          </p>
          {optional.length ? (
            <ul className="mt-2 space-y-1.5">
              {optional.map((tool) => {
                const on = enabled.has(tool.id)
                return (
                  <li key={tool.id}>
                    <label htmlFor={`assistant-tool-${tool.id}`} aria-label={`Let the assistant use ${tool.name}`} className={cn('flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm', on ? 'border-horizon-300 bg-horizon-50' : 'border-border hover:bg-muted/50', !canEdit && 'cursor-not-allowed opacity-60')}>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{tool.name}</span>
                        <span className="block text-xs text-muted-foreground">{tool.error ? tool.error : `${tool.tools} tool${tool.tools === 1 ? '' : 's'}`}</span>
                      </span>
                      <input
                        id={`assistant-tool-${tool.id}`}
                        type="checkbox"
                        checked={on}
                        disabled={!canEdit}
                        onChange={() => setEnabled((current) => { const next = new Set(current); if (next.has(tool.id)) next.delete(tool.id); else next.add(tool.id); return next })}
                        className="h-4 w-4 accent-horizon-600"
                      />
                    </label>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No other integrations to add. <Link href="/integrations" className="font-medium text-horizon-700 hover:underline">Connect one</Link> and it appears here.
            </p>
          )}
          {fixed.length > 0 && (
            <ul className="mt-3 space-y-1">
              {fixed.map((tool) => (
                <li key={tool.id} className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
                  <span className="flex min-w-0 items-center gap-1.5 truncate"><Plug className="h-3.5 w-3.5 shrink-0" aria-hidden />{tool.name}</span>
                  <span className="flex shrink-0 items-center gap-1"><Check className="h-3.5 w-3.5 text-green-600" aria-hidden />{SOURCE_NOTE[tool.source]}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
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
