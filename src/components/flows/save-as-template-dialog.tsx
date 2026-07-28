'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import type { FlowGraph } from '@/lib/flows/graph'
import type { FlowTemplateBinding, FlowTemplateNotes } from '@/lib/flows/templates/types'

/**
 * "Save as template" — capture the current graph as a reusable flow template.
 *
 * The graph alone isn't a template: what makes one worth having is the
 * explanation. So the dialog drafts the notes from the graph the moment it
 * opens and puts them in front of the user to correct, rather than asking them
 * to write a step-by-step walkthrough from a blank box.
 */
export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  flowId,
  flowName,
  flowDescription,
  graph,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flowId: string
  flowName: string
  flowDescription: string
  graph: FlowGraph
}) {
  const [name, setName] = useState(flowName)
  const [description, setDescription] = useState(flowDescription)
  const [category, setCategory] = useState('Custom')
  const [tags, setTags] = useState('')
  const [integrations, setIntegrations] = useState('')
  const [publish, setPublish] = useState(false)
  const [notes, setNotes] = useState<FlowTemplateNotes | null>(null)
  const [bindings, setBindings] = useState<FlowTemplateBinding[]>([])
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(flowName)
    setDescription(flowDescription)
    let cancelled = false
    setDrafting(true)
    setDraftError(null)
    fetch('/api/flow-templates/draft-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: flowName || 'Untitled flow', description: flowDescription, graph }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || 'Could not draft the notes.')
        return data
      })
      .then((data) => {
        if (cancelled) return
        setNotes(data.notes)
        setBindings(data.bindings || [])
      })
      .catch((error: Error) => {
        if (!cancelled) setDraftError(error.message)
      })
      .finally(() => {
        if (!cancelled) setDrafting(false)
      })
    return () => {
      cancelled = true
    }
    // flowId keys the draft to this flow; graph is captured at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flowId])

  const setStepText = (nodeId: string, what: string) => {
    setNotes((prev) => (prev ? { ...prev, steps: prev.steps.map((step) => (step.nodeId === nodeId ? { ...step, what } : step)) } : prev))
  }

  const csv = (value: string) => value.split(',').map((entry) => entry.trim()).filter(Boolean)

  const save = async () => {
    if (!notes) return
    setSaving(true)
    try {
      const response = await fetch('/api/flow-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || 'Untitled flow',
          description: description.trim(),
          category: category.trim() || 'Custom',
          graph,
          notes,
          bindings,
          tags: csv(tags),
          integrations: csv(integrations),
          ...(publish ? { visibility: 'global' } : {}),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(data.error || 'Could not save the template.')
        return
      }
      toast.success(publish ? 'Published to the community library.' : 'Saved to your flow templates.')
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Save as a flow template</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Churn-risk scorecard" />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Category</span>
              <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Customer Success" />
            </label>
          </div>

          <label className="block space-y-1.5 text-sm">
            <span className="font-medium">Description</span>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="One or two sentences on what someone gets from this flow."
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Tags</span>
              <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="weekly, scoring" />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Integrations it needs</span>
              <Input value={integrations} onChange={(event) => setIntegrations(event.target.value)} placeholder="Slack, Salesforce" />
            </label>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-indigo-500" /> Step-by-step notes
              </p>
              {drafting && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your flow…</span>}
            </div>

            {draftError ? (
              <p className="text-sm text-muted-foreground">
                {draftError} You can still save — but a template without notes is much harder for anyone else to use.
              </p>
            ) : !notes ? (
              <p className="text-sm text-muted-foreground">Drafting an explanation of each step from the graph. You can edit everything before saving.</p>
            ) : (
              <div className="space-y-4">
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">What it achieves</span>
                  <Textarea value={notes.objective} onChange={(event) => setNotes({ ...notes, objective: event.target.value })} rows={3} />
                </label>

                <div className="space-y-2">
                  <p className="text-sm font-medium">Steps</p>
                  {notes.steps.map((step, index) => (
                    <div key={step.nodeId} className="flex gap-2.5">
                      <span className="mt-1.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">{step.title}</p>
                        <Textarea value={step.what} onChange={(event) => setStepText(step.nodeId, event.target.value)} rows={2} className="text-sm" />
                      </div>
                    </div>
                  ))}
                </div>

                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Decision rules</span>
                  <Textarea
                    value={notes.decisionRules ?? ''}
                    onChange={(event) => setNotes({ ...notes, decisionRules: event.target.value })}
                    rows={2}
                    placeholder="Thresholds and branch conditions, in plain English."
                  />
                </label>

                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">When things go wrong</span>
                  <Textarea
                    value={notes.failureHandling ?? ''}
                    onChange={(event) => setNotes({ ...notes, failureHandling: event.target.value })}
                    rows={2}
                    placeholder="Retries, partial failures, what happens when something is unreachable."
                  />
                </label>

                {(bindings.length > 0 || notes.setup.length > 0) && (
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium">Whoever uses this will need to</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[...bindings.map((binding) => binding.label), ...notes.setup.map((step) => step.label)].map((label) => (
                        <Badge key={label} variant="outline" className="text-xs font-normal text-muted-foreground">{label}</Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Your agents and connections aren&apos;t copied into the template — each is recorded as a slot the next workspace fills with its own.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} className="mt-1" />
            <span>
              <span className="font-medium">Publish to the community library</span>
              <span className="block text-xs text-muted-foreground">Other workspaces can find and use it. Leave off to keep it to this workspace.</span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={drafting || !notes}>
            {publish ? 'Publish template' : 'Save template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
