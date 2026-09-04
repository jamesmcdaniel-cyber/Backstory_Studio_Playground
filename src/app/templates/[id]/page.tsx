'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Bot, Copy, Info, Pencil, Plug, RotateCcw, Save, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { IntegrationConnectDialog } from '@/components/integrations/integration-connect-dialog'
import { IntegrationPicker } from '@/components/integrations/integration-picker'
import { unmetRequirements, type WorkspaceConnections } from '@/components/integrations/integration-match'
import { HtmlPreview, looksLikeHtml, unwrapHtmlFence } from '@/components/ui/html-preview'
import { SubmitToCatalogue, type SubmissionStatus } from '@/components/templates/submit-to-catalogue'
import { notifyAgentsChanged } from '@/components/layout/sidebar'
import { createAgentFromTemplate, type TemplateDestination } from '@/lib/client/agent-from-template'
import { AssignTemplateDialog } from '@/components/agents/assign-template-dialog'
import { applyEdits, diffTemplate, hasEdits, tailorProblem, type TailorableTemplate } from '@/lib/templates/tailor'
import { useAuth } from '@/hooks/use-auth'

type Template = {
  id: string
  name: string
  description: string
  category?: string
  instructions: string
  integrations: string[]
  skills?: string[]
  tags?: string[]
  model: string
  exampleOutput?: string
  icon?: string
  allowSubagents?: boolean
  allowFlows?: boolean
  alwaysStrategize?: boolean
  requireApproval?: boolean
  schedule?: {
    type: 'manual' | 'hourly' | 'daily' | 'weekly' | 'cron' | 'once'
    time?: string
    cron?: string
    timezone?: string
    runAt?: string
    isActive?: boolean
  }
  /** Stored in this workspace, so editing writes back instead of forking. */
  mine?: boolean
  /** Set on templates that provision a complete multi-step Flow (agents + graph). */
  playbook?: string
}

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [creating, setCreating] = useState(false)
  // Installing asks WHO does the job before it creates anything.
  const [assignOpen, setAssignOpen] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [submission, setSubmission] = useState<SubmissionStatus | null>(null)
  // The template as this person wants it: what installs, what a copy saves.
  // Null until the template loads; seeded from it, then owned by the editor.
  const [draft, setDraft] = useState<TailorableTemplate | null>(null)
  const [editing, setEditing] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  // What this workspace has actually connected. Null until it answers — the
  // banner stays hidden rather than flashing a "connect these" list that
  // resolves to nothing a moment later.
  const [workspace, setWorkspace] = useState<WorkspaceConnections | null>(null)
  const { can } = useAuth()
  const canSubmit = can('template.submit')
  const canAuthor = can('template.author')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('load failed'))))
      .then((data) => {
        if (cancelled) return
        const found: Template | null = (data.templates || []).find((item: Template) => item.id === id) || null
        setTemplate(found)
        // Seed the draft from what shipped. Any tailoring is measured against
        // this, so re-seeding on a later refetch would silently discard edits —
        // it happens once per template id, on load.
        setDraft(found ? { instructions: found.instructions, integrations: found.integrations } : null)
        setEditing(false)
      })
      .catch(() => {
        // Transient failure — distinct from "loaded, but no such template" so we
        // never sit on an infinite skeleton (a deleted/unknown id resolves to a
        // clean not-found state below, a 500/timeout to a retryable error state).
        if (!cancelled) setLoadError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // The workspace's connected tools, so the banner can name only what's missing.
  // Refetched when the user comes back to the tab — connecting happens on
  // another surface, and returning here should show the banner shrink.
  const loadWorkspace = useCallback(() => {
    fetch('/api/integrations/available', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.success) return
        setWorkspace({ tools: data.tools ?? [], connections: data.connections ?? [] })
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadWorkspace()
    const refetchOnReturn = () => { if (!document.hidden) loadWorkspace() }
    window.addEventListener('focus', refetchOnReturn)
    document.addEventListener('visibilitychange', refetchOnReturn)
    return () => {
      window.removeEventListener('focus', refetchOnReturn)
      document.removeEventListener('visibilitychange', refetchOnReturn)
    }
  }, [loadWorkspace])

  // Where this template stands with the catalogue reviewers, if this workspace
  // may submit at all. Best-effort: a failure just hides the status, never the
  // page.
  const loadSubmission = useCallback(() => {
    if (!canSubmit) return
    fetch('/api/catalogue/submissions', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.success) return
        const match = data.submissions.find(
          (row: { sourceId: string | null; status: string }) => row.sourceId === id && row.status !== 'withdrawn',
        )
        setSubmission(match ?? null)
      })
      .catch(() => {})
  }, [canSubmit, id])

  useEffect(() => { loadSubmission() }, [loadSubmission])

  // The tailored template — the ONE value every action below reads, so what is
  // on screen is exactly what gets installed, copied, or saved.
  const working: TailorableTemplate | null = draft ?? (template ? { instructions: template.instructions, integrations: template.integrations } : null)
  const edits = template && working ? diffTemplate(template, working) : {}
  const tailored = hasEdits(edits)
  const problem = working ? tailorProblem(working) : null

  const setInstructions = (instructions: string) => setDraft((current) => ({ integrations: working?.integrations ?? [], ...current, instructions }))
  const toggleTool = (tool: string) =>
    setDraft((current) => {
      const tools = current?.integrations ?? working?.integrations ?? []
      return {
        instructions: current?.instructions ?? working?.instructions ?? '',
        integrations: tools.includes(tool) ? tools.filter((item) => item !== tool) : [...tools, tool],
      }
    })
  const resetDraft = () => {
    if (!template) return
    setDraft({ instructions: template.instructions, integrations: template.integrations })
  }

  const createAgent = async (destination: TemplateDestination) => {
    if (!template) return
    setCreating(true)
    // Install what is on screen, not what shipped: the whole point of tailoring
    // is that this workspace's agent differs from the catalogue's description.
    const result = await createAgentFromTemplate(applyEdits(template, edits), destination)
    setCreating(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    setAssignOpen(false)
    // Land on the agent itself, so the instructions this template just handed
    // over are right there to review, run, or schedule.
    notifyAgentsChanged()
    router.push(result.href)
  }

  /**
   * Keep the tailored version as a template.
   *
   * A template this workspace owns is updated in place. Anything else — a
   * built-in, or another workspace's community template — is COPIED, because
   * neither is ours to change: built-ins live in code and community templates
   * belong to the org that wrote them. The copy is an ordinary workspace
   * template, editable from then on like any other.
   */
  const saveTemplate = async (mode: 'update' | 'copy') => {
    if (!template || !working) return
    if (problem) {
      toast.error(problem)
      return
    }
    setSavingTemplate(true)
    const payload = {
      name: mode === 'copy' ? `${template.name} (copy)` : template.name,
      category: template.category || 'Custom',
      description: template.description,
      instructions: working.instructions,
      integrations: working.integrations,
      skills: template.skills ?? [],
      tags: template.tags ?? [],
      model: template.model,
      ...(template.exampleOutput ? { exampleOutput: template.exampleOutput } : {}),
      ...(template.icon ? { icon: template.icon } : {}),
      ...(template.allowSubagents ? { allowSubagents: true } : {}),
      ...(template.allowFlows ? { allowFlows: true } : {}),
      ...(template.alwaysStrategize ? { alwaysStrategize: true } : {}),
      ...(template.requireApproval ? { requireApproval: true } : {}),
      ...(template.schedule ? { schedule: template.schedule } : {}),
    }
    try {
      const response = await fetch('/api/agent-templates', {
        method: mode === 'update' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'update' ? { id: template.id, ...payload } : payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save this template.')
      if (mode === 'update') {
        setTemplate((current) => (current ? { ...current, ...working } : current))
        setEditing(false)
        toast.success('Template updated')
        return
      }
      toast.success('Saved to your workspace')
      // The copy is a different template with a different id — send the user to
      // it, so the page they keep editing is the one their changes land on.
      if (typeof data.template?.id === 'string') router.push(`/templates/${data.template.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save this template.')
    } finally {
      setSavingTemplate(false)
    }
  }

  // The requirements this workspace hasn't connected yet, measured against the
  // TAILORED tool list: swapping a tool out is the fix for this banner, so it
  // has to shrink as the user makes it. Empty until the workspace answers, so a
  // slow/failed read never asks for tools that are already in place.
  const selectedTools = working?.integrations
  const missing = useMemo(
    () => (selectedTools && workspace ? unmetRequirements(selectedTools, workspace) : []),
    [selectedTools, workspace],
  )

  // Playbook templates provision the full motion: agents + a wired Flow.
  const deployPlaybook = async () => {
    if (!template?.playbook) return
    setDeploying(true)
    const response = await fetch(`/api/playbooks/${template.playbook}`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    setDeploying(false)
    if (response.ok && data.flowId) router.push(`/flows/${data.flowId}`)
    else toast.error(data.error || 'Could not deploy this playbook. Please try again.')
  }

  return (
    <>
      <div className="space-y-5">
        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-2/3 rounded-lg" />
            <Skeleton className="h-5 w-full rounded" />
            <div className="grid gap-5 lg:grid-cols-2">
              <Skeleton className="h-72 rounded-xl" />
              <Skeleton className="h-72 rounded-xl" />
            </div>
          </div>
        ) : loadError ? (
          <EmptyState
            title="Couldn’t load this template"
            description="The connection may have dropped. Try again in a moment."
            action={<Button onClick={() => window.location.reload()}>Try again</Button>}
          />
        ) : !template || !working ? (
          <EmptyState
            title="Template not found"
            description="It may have been removed or is no longer shared."
            action={<Button variant="outline" onClick={() => router.push('/templates')}>Back to Library</Button>}
          />
        ) : (
          <>
            <Link href="/templates" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back to Library
            </Link>

            <div className="flex animate-fade-in-up flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <p className="eyebrow mb-1">Template</p>
                <h1 className="text-2xl font-bold leading-tight">{template.name}</h1>
                <p className="mt-2 max-w-2xl text-muted-foreground">{template.description}</p>
                <div className="mt-3">
                  <SubmitToCatalogue
                    item={{ id: template.id, kind: 'agent_template', name: template.name }}
                    canSubmit={canSubmit}
                    submission={submission}
                    onSubmitted={loadSubmission}
                  />
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant={template.playbook ? 'outline' : 'default'}
                  onClick={() => setAssignOpen(true)}
                  loading={creating}
                  disabled={Boolean(problem)}
                >
                  <Bot className="mr-1.5 h-4 w-4" />
                  {creating ? 'Adding…' : 'Add to a teammate'}
                </Button>
                {template.playbook && (
                  <Button onClick={deployPlaybook} loading={deploying}>
                    <Workflow className="mr-1.5 h-4 w-4" />
                    {deploying ? 'Creating…' : 'Create flow'}
                  </Button>
                )}
              </div>
            </div>

            {/* Tailoring bar. A template is someone else's guess at two things:
                what the agent should do, and what it does it with. Either half
                can be wrong for this workspace, so both are editable here and
                the edits follow through to every action on the page. */}
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {tailored ? (
                  <>
                    <Badge variant="outline" className="border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300">Tailored</Badge>
                    <span className="text-muted-foreground">
                      {template.mine
                        ? 'Your changes apply to the agent you create. Save them to keep them on the template.'
                        : 'Your changes apply to the agent you create. The template itself is unchanged.'}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Instructions off, or tools you don’t use? Adjust them before adding this to a teammate.
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {tailored && (
                  <Button size="sm" variant="ghost" onClick={resetDraft} disabled={savingTemplate}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" /> {editing ? 'Done editing' : 'Edit'}
                </Button>
                {canAuthor && (
                  template.mine ? (
                    <Button size="sm" variant="outline" onClick={() => saveTemplate('update')} loading={savingTemplate} disabled={!tailored || Boolean(problem)}>
                      <Save className="mr-1.5 h-3.5 w-3.5" /> Save changes
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => saveTemplate('copy')} loading={savingTemplate} disabled={Boolean(problem)}>
                      <Copy className="mr-1.5 h-3.5 w-3.5" /> Save as a copy
                    </Button>
                  )
                )}
              </div>
            </div>

            {problem && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-400">{problem}</p>
            )}

            {/* Only what's actually MISSING. A workspace that already has these
                connected sees nothing here — a banner that keeps asking for
                tools you've connected is a banner people stop reading. */}
            {missing.length > 0 && (
              <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Info className="h-4 w-4 shrink-0" />
                  <span>This template still needs</span>
                  {missing.map((requirement) => (
                    <IntegrationChip
                      key={requirement.name}
                      name={requirement.name}
                      onClick={() => setConnectOpen(true)}
                      className="border-amber-300/70 bg-amber-100/70 text-amber-900 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100 dark:hover:bg-amber-400/20"
                    />
                  ))}
                  <span>— connect {missing.length === 1 ? 'it' : 'them'}, or swap {missing.length === 1 ? 'it' : 'them'} out under Requires.</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConnectOpen(true)}
                  className="shrink-0 self-start border-amber-300 bg-white/70 text-amber-900 hover:bg-white dark:border-amber-400/30 dark:bg-transparent dark:text-amber-100 sm:self-auto"
                >
                  <Plug className="mr-1.5 h-3.5 w-3.5" /> Connect
                </Button>
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-2">
              <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
                <p className="eyebrow mb-3" id="template-instructions-label">Agent instructions</p>
                {editing ? (
                  <Textarea
                    aria-labelledby="template-instructions-label"
                    rows={16}
                    value={working.instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    className="font-mono text-[13px] leading-relaxed"
                    placeholder="What this agent should do…"
                  />
                ) : (
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-[13px] leading-relaxed text-foreground/90">{working.instructions}</pre>
                )}
              </section>

              <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
                <div className="mb-3 flex items-center justify-between">
                  <p className="eyebrow">Output example</p>
                  <span className="text-xs text-muted-foreground">Illustrative</span>
                </div>
                {template.exampleOutput ? (
                  looksLikeHtml(unwrapHtmlFence(template.exampleOutput)) ? (
                    <HtmlPreview html={unwrapHtmlFence(template.exampleOutput)} />
                  ) : (
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{template.exampleOutput}</p>
                    </div>
                  )
                ) : (
                  <p className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
                    This template doesn&apos;t include a sample output yet — the real output uses your live data.
                  </p>
                )}
                {template.exampleOutput && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {tailored
                      ? 'The example shows the template as published — your edits change what a run actually produces.'
                      : 'Actual output uses your connected tools and live data.'}
                  </p>
                )}
              </section>
            </div>

            <div className="grid gap-4 rounded-2xl border border-border/60 bg-card p-5 shadow-1 sm:grid-cols-2">
              <div>
                <p className="eyebrow mb-2">Automation</p>
                <p className="text-sm text-muted-foreground">
                  {template.playbook
                    ? 'Deploys a wired flow you can run manually or schedule.'
                    : 'Runs manually, or add a schedule after connecting.'}
                </p>
              </div>
              <div>
                <p className="eyebrow mb-2" id="template-requires-label">Requires</p>
                {editing ? (
                  <>
                    <IntegrationPicker
                      available={workspace}
                      selected={working.integrations}
                      onToggle={toggleTool}
                      labelledBy="template-requires-label"
                      showConnectionState
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      A green dot means your workspace has already connected that tool.
                    </p>
                  </>
                ) : working.integrations.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {working.integrations.map((integration) => (
                      <IntegrationChip key={integration} name={integration} onClick={() => setConnectOpen(true)} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No integrations required.</p>
                )}
              </div>
            </div>

            <IntegrationConnectDialog
              open={connectOpen}
              onOpenChange={setConnectOpen}
              names={working.integrations}
              description={`${template.name} needs these connected before every step can run.`}
            />

            {assignOpen && (
              <AssignTemplateDialog
                templateName={template.name}
                busy={creating}
                onCancel={() => setAssignOpen(false)}
                onConfirm={createAgent}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}
