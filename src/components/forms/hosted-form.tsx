'use client'

import { useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { HostedFormDefinition } from '@/lib/flows/form'

export function HostedForm({ flowId, definition }: { flowId: string; definition: HostedFormDefinition }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [website, setWebsite] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/forms/${flowId}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values, website }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'The form could not be submitted.')
      setSubmitted(true)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The form could not be submitted.')
    } finally {
      setBusy(false)
    }
  }

  if (submitted) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center" role="status">
        <CheckCircle2 className="h-10 w-10 text-emerald-600" />
        <h1 className="text-2xl font-semibold">Submitted</h1>
        <p className="max-w-md text-muted-foreground">{definition.successMessage}</p>
      </div>
    )
  }

  return (
    <form className="space-y-5" onSubmit={(event) => void submit(event)}>
      <div className="space-y-1.5">
        <p className="font-mono text-xs font-bold uppercase tracking-widest text-horizon-600">Backstory form</p>
        <h1 className="text-3xl font-bold tracking-tight">{definition.title}</h1>
        {definition.description && <p className="text-sm leading-6 text-muted-foreground">{definition.description}</p>}
      </div>
      <input tabIndex={-1} autoComplete="off" className="absolute -left-[10000px]" name="website" value={website} onChange={(event) => setWebsite(event.target.value)} aria-hidden="true" />
      {definition.fields.map((field) => {
        const name = field.name
        const descriptionId = field.description ? `${name}-description` : undefined
        return (
          <div key={name} className="space-y-1.5">
            <Label htmlFor={name}>{name}{field.required && <span className="text-red-600"> *</span>}</Label>
            {field.type === 'boolean' ? (
              <label className="flex h-11 items-center gap-2 rounded-md border bg-background px-3 text-sm">
                <input id={name} type="checkbox" checked={Boolean(values[name])} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.checked }))} /> Yes
              </label>
            ) : field.type === 'object' || field.type === 'array' || field.type === 'any' ? (
              <Textarea id={name} required={field.required} aria-describedby={descriptionId} rows={4} value={String(values[name] ?? field.default ?? '')} placeholder={field.type === 'array' ? '[ ]' : field.type === 'object' ? '{ }' : field.description} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
            ) : (
              <Input id={name} required={field.required} aria-describedby={descriptionId} type={field.type === 'number' ? 'number' : 'text'} value={String(values[name] ?? field.default ?? '')} placeholder={field.description} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} />
            )}
            {field.description && <p id={descriptionId} className="text-xs text-muted-foreground">{field.description}</p>}
          </div>
        )
      })}
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{definition.submitLabel}
      </Button>
      <p className="text-center text-xs text-muted-foreground">Your submission starts an automated workflow managed by the form owner.</p>
    </form>
  )
}
