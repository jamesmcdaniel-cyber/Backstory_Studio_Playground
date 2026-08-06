'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowLeft, CheckCircle2, CircleAlert, Layers, Play, Plug, Bot, SlidersHorizontal, ShieldAlert, ListChecks, FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { IntegrationConnectDialog } from '@/components/integrations/integration-connect-dialog'
import { FlowGraphPreview } from '@/components/flows/flow-graph-preview'
import { SubmitToCatalogue, type SubmissionStatus } from '@/components/templates/submit-to-catalogue'
import { useAuth } from '@/hooks/use-auth'
import type { FlowGraph } from '@/lib/flows/graph'
import { cn } from '@/lib/utils'

type StepNote = { nodeId: string; title: string; what: string; why?: string }
type SetupStep = { label: string; kind: 'integration' | 'agent' | 'value'; ref?: string }
type InputNote = { name: string; description: string; example?: string }

type FlowTemplate = {
  id: string
  name: string
  description: string
  category: string
  icon?: string
  integrations: string[]
  tags: string[]
  stepCount: number
  source: string
  notes: {
    objective: string
    inputs: InputNote[]
    steps: StepNote[]
    decisionRules?: string
    failureHandling?: string
    setup: SetupStep[]
    customize: string[]
    testPlan?: string
  }
  bindings: { nodeId: string; kind: 'agent' | 'connection'; label: string }[]
  graph: FlowGraph
  custom: boolean
  mine: boolean
  version: number
}

type TemplateVersion = { id: string; version: number; savedByName: string | null; createdAt: string }

const SETUP_ICON = { integration: Plug, agent: Bot, value: SlidersHorizontal } as const

/**
 * A flow template's detail page. The job here is to let someone decide whether
 * this pipeline is right for them WITHOUT opening the builder — so the page
 * leads with the objective, walks every step in order, and states the setup
 * cost up front rather than burying it behind the button.
 */
export default function FlowTemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<FlowTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [using, setUsing] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [versions, setVersions] = useState<TemplateVersion[]>([])
  const [restoring, setRestoring] = useState<number | null>(null)
  const [submission, setSubmission] = useState<SubmissionStatus | null>(null)
  const { can } = useAuth()
  const canSubmit = can('template.submit')

  // Where this template stands with the catalogue reviewers, if this workspace
  // may submit at all. Best-effort: a failure just hides the status, never the
  // page. Built-ins have no workspace row to snapshot, so they never offer it.
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

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    fetch(`/api/flow-templates/${id}`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('load failed'))))
      .then((data) => {
        if (!cancelled) setTemplate(data.template ?? null)
      })
      .catch(() => {
        if (!cancelled) setLoadError(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  // History exists only for stored rows this workspace owns — built-ins have
  // no version rows and the endpoint 404s for them, so don't ask.
  useEffect(() => {
    if (!template?.custom || !template.mine) return
    let cancelled = false
    fetch(`/api/flow-templates/${id}/versions`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setVersions(data.versions ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, template?.custom, template?.mine])

  const restoreVersion = async (version: number) => {
    setRestoring(version)
    try {
      const response = await fetch(`/api/flow-templates/${id}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version, action: 'restore' }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.template) {
        toast.error(data.error || 'Could not restore that version.')
        return
      }
      setTemplate(data.template)
      toast.success(`Restored version ${version} — the template is now v${data.template.version}.`)
      const listed = await fetch(`/api/flow-templates/${id}/versions`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (listed?.success) setVersions(listed.versions ?? [])
    } finally {
      setRestoring(null)
    }
  }

  const useTemplate = async () => {
    setUsing(true)
    try {
      const response = await fetch(`/api/flow-templates/${id}/use`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flow) {
        toast.error(data.error || 'Could not create the flow. Please try again.')
        return
      }
      const outstanding = Array.isArray(data.setup) ? data.setup.length : 0
      toast.success(
        outstanding > 0
          ? `Created as a draft — ${outstanding} thing${outstanding === 1 ? '' : 's'} left to set up.`
          : 'Created as a draft, ready to run.',
      )
      router.push(`/flows/${data.flow.id}`)
    } finally {
      setUsing(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <Skeleton className="h-9 w-2/3 rounded-lg" />
        <Skeleton className="h-5 w-full rounded" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    )
  }

  if (loadError || !template) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <EmptyState
          title={loadError ? 'Couldn’t load this flow template' : 'Flow template not found'}
          description={loadError ? 'The connection may have dropped. Try again in a moment.' : 'It may have been removed or is no longer shared.'}
          action={
            loadError ? (
              <Button onClick={() => window.location.reload()}>Try again</Button>
            ) : (
              <Button variant="outline" onClick={() => router.push('/agents?view=templates')}>Back to templates</Button>
            )
          }
        />
      </div>
    )
  }

  const { notes } = template
  const setupCount = template.bindings.length + notes.setup.length
  const readyNow = setupCount === 0

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Link href="/agents?view=templates" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to templates
      </Link>

      <div className="flex animate-fade-in-up flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Flow template</p>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold leading-tight">
            {template.icon && <span aria-hidden>{template.icon}</span>}
            {template.name}
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">{template.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant="outline">{template.category}</Badge>
            {template.custom && template.version > 1 && (
              <Badge variant="outline" className="text-xs text-muted-foreground">v{template.version}</Badge>
            )}
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Layers className="h-3.5 w-3.5" /> {template.stepCount} steps
            </span>
            <span className={cn('text-xs font-medium', readyNow ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
              {readyNow ? 'Ready to run' : `${setupCount} to set up`}
            </span>
            {template.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs text-muted-foreground">{tag}</Badge>
            ))}
          </div>
          {template.custom && (
            <div className="mt-3">
              <SubmitToCatalogue
                item={{ id: template.id, kind: 'flow_template', name: template.name }}
                canSubmit={canSubmit}
                submission={submission}
                onSubmitted={loadSubmission}
              />
            </div>
          )}
        </div>
        <Button onClick={useTemplate} loading={using} className="shrink-0">
          <Play className="mr-1.5 h-4 w-4" />
          {using ? 'Creating…' : 'Use this flow'}
        </Button>
      </div>

      <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
        <p className="eyebrow mb-2">What it does</p>
        <p className="text-sm leading-relaxed text-foreground/90">{notes.objective}</p>
        {notes.inputs.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="eyebrow">What you provide</p>
            <ul className="space-y-1.5">
              {notes.inputs.map((input) => (
                <li key={input.name} className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{input.name}</span> — {input.description}
                  {input.example && <span className="text-muted-foreground/80"> (for example: {input.example})</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {(template.bindings.length > 0 || notes.setup.length > 0) && (
        <section className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5 dark:border-amber-500/25 dark:bg-amber-500/10">
          <p className="eyebrow mb-3 flex items-center gap-1.5 text-amber-900 dark:text-amber-200">
            <ListChecks className="h-4 w-4" /> Before it can run
          </p>
          <ul className="space-y-2">
            {template.bindings.map((binding) => {
              const Icon = binding.kind === 'agent' ? Bot : Plug
              return (
                <li key={binding.nodeId} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" /> {binding.label}
                </li>
              )
            })}
            {notes.setup.map((step) => {
              const Icon = SETUP_ICON[step.kind]
              return (
                <li key={step.label} className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" /> {step.label}
                </li>
              )
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-amber-800/90 dark:text-amber-200/80">
              You don&apos;t have to do this first — the flow is created as a draft either way, with each of these flagged on the step it belongs to.
            </p>
            {template.integrations.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConnectOpen(true)}
                className="shrink-0 border-amber-300 bg-white/70 text-amber-900 hover:bg-white dark:border-amber-400/30 dark:bg-transparent dark:text-amber-100"
              >
                <Plug className="mr-1.5 h-3.5 w-3.5" /> Connect integrations
              </Button>
            )}
          </div>
        </section>
      )}

      {template.graph?.nodes?.length > 1 && (
        <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
          <p className="eyebrow mb-3">The shape of it</p>
          <FlowGraphPreview graph={template.graph} />
        </section>
      )}

      <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
        <p className="eyebrow mb-4">Step by step</p>
        <ol className="space-y-4">
          {notes.steps.map((step, index) => (
            <li key={step.nodeId} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                {index + 1}
              </span>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium leading-snug">{step.title}</p>
                <p className="text-sm text-muted-foreground">{step.what}</p>
                {step.why && (
                  <p className="border-l-2 border-border pl-2.5 text-sm italic text-muted-foreground/90">{step.why}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {notes.decisionRules && (
          <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
            <p className="eyebrow mb-2 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Decision rules</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{notes.decisionRules}</p>
          </section>
        )}
        {notes.failureHandling && (
          <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
            <p className="eyebrow mb-2 flex items-center gap-1.5"><ShieldAlert className="h-4 w-4" /> When things go wrong</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{notes.failureHandling}</p>
          </section>
        )}
        {notes.customize.length > 0 && (
          <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
            <p className="eyebrow mb-2 flex items-center gap-1.5"><SlidersHorizontal className="h-4 w-4" /> Worth tuning</p>
            <ul className="space-y-1.5">
              {notes.customize.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" /> {item}
                </li>
              ))}
            </ul>
          </section>
        )}
        {notes.testPlan && (
          <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
            <p className="eyebrow mb-2 flex items-center gap-1.5"><FlaskConical className="h-4 w-4" /> Check it before you switch it on</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{notes.testPlan}</p>
          </section>
        )}
      </div>

      {template.integrations.length > 0 && (
        <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="eyebrow">Requires</p>
            <button
              type="button"
              onClick={() => setConnectOpen(true)}
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Connect
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {template.integrations.map((integration) => (
              <IntegrationChip key={integration} name={integration} onClick={() => setConnectOpen(true)} />
            ))}
          </div>
        </section>
      )}

      {versions.length > 0 && (
        <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
          <p className="eyebrow mb-3">History</p>
          <ul className="divide-y divide-border/60">
            {versions.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">Version {entry.version}</span>
                  <span className="ml-2 text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                    {entry.savedByName ? ` · ${entry.savedByName}` : ''}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  loading={restoring === entry.version}
                  onClick={() => restoreVersion(entry.version)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Each edit keeps the previous version here. Restoring is safe — the current version is saved before it&apos;s replaced.
          </p>
        </section>
      )}

      <IntegrationConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        names={template.integrations}
        description={`${template.name} needs these connected before the flow can run end to end.`}
      />
    </div>
  )
}
