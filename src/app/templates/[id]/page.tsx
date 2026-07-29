'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, Bot, Info, Plug, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { IntegrationChip } from '@/components/integrations/integration-chip'
import { IntegrationConnectDialog } from '@/components/integrations/integration-connect-dialog'
import { HtmlPreview, looksLikeHtml } from '@/components/ui/html-preview'
import { SubmitToCatalogue, type SubmissionStatus } from '@/components/templates/submit-to-catalogue'
import { useAuth } from '@/hooks/use-auth'

type Template = {
  id: string
  name: string
  description: string
  instructions: string
  integrations: string[]
  skills?: string[]
  model: string
  exampleOutput?: string
  icon?: string
  allowSubagents?: boolean
  // Set on templates that provision a complete multi-step Flow (agents + graph).
  playbook?: string
}

export default function TemplateDetails() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [submission, setSubmission] = useState<SubmissionStatus | null>(null)
  const { can } = useAuth()
  const canSubmit = can('template.submit')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(false)
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('load failed'))))
      .then((data) => {
        if (cancelled) return
        setTemplate((data.templates || []).find((item: Template) => item.id === id) || null)
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

  const createAgent = async () => {
    if (!template) return
    setCreating(true)
    const response = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: template.name,
        description: template.description,
        instructions: template.instructions,
        integrations: template.integrations,
        skills: template.skills || [],
        model: template.model,
        icon: template.icon || '',
        allowSubagents: template.allowSubagents === true,
        schedule: { type: 'manual', timezone: 'UTC', isActive: false },
      }),
    })
    setCreating(false)
    if (response.ok) {
      router.push('/dashboard')
    } else {
      const data = await response.json().catch(() => ({}))
      toast.error(data.error || 'Could not create the agent. Please try again.')
    }
  }

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
        ) : !template ? (
          <EmptyState
            title="Template not found"
            description="It may have been removed or is no longer shared."
            action={<Button variant="outline" onClick={() => router.push('/agents?view=templates')}>Back to templates</Button>}
          />
        ) : (
          <>
            <Link href="/agents?view=templates" className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> Back to templates
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
                <Button variant={template.playbook ? 'outline' : 'default'} onClick={createAgent} loading={creating}>
                  <Bot className="mr-1.5 h-4 w-4" />
                  {creating ? 'Creating…' : 'Connect to agent'}
                </Button>
                {template.playbook && (
                  <Button onClick={deployPlaybook} loading={deploying}>
                    <Workflow className="mr-1.5 h-4 w-4" />
                    {deploying ? 'Deploying…' : 'Connect to flow'}
                  </Button>
                )}
              </div>
            </div>

            {template.integrations.length > 0 && (
              <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <Info className="h-4 w-4 shrink-0" />
                  <span>This template uses</span>
                  {template.integrations.map((integration) => (
                    <IntegrationChip
                      key={integration}
                      name={integration}
                      onClick={() => setConnectOpen(true)}
                      className="border-amber-300/70 bg-amber-100/70 text-amber-900 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100 dark:hover:bg-amber-400/20"
                    />
                  ))}
                  <span>— connect them so every step can run.</span>
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
                <p className="eyebrow mb-3">Agent instructions</p>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-[13px] leading-relaxed text-foreground/90">{template.instructions}</pre>
              </section>

              <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
                <div className="mb-3 flex items-center justify-between">
                  <p className="eyebrow">Output example</p>
                  <span className="text-xs text-muted-foreground">Illustrative</span>
                </div>
                {template.exampleOutput ? (
                  looksLikeHtml(template.exampleOutput) ? (
                    <HtmlPreview html={template.exampleOutput} />
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
                  <p className="mt-2 text-xs text-muted-foreground">Actual output uses your connected tools and live data.</p>
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
                <p className="eyebrow mb-2">Requires</p>
                {template.integrations.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {template.integrations.map((integration) => (
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
              names={template.integrations}
              description={`${template.name} needs these connected before every step can run.`}
            />
          </>
        )}
      </div>
    </>
  )
}
