import Link from 'next/link'
import { headers } from 'next/headers'
import { Layers, Lock } from 'lucide-react'
import { FlowGraphPreview } from '@/components/flows/flow-graph-preview'
import { resolveAnonymousFlowShare } from '@/lib/flows/public-share'

export const dynamic = 'force-dynamic'

/**
 * The anonymous share surface: a read-only look at a flow's shape for someone
 * who has no account. Rendered server-side from a sanitized projection (see
 * public-graph.ts) — there is no client fetching, no API the page can be
 * pivoted into, and no session involved at all.
 */
export const metadata = { robots: { index: false, follow: false } }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-muted/30">
      <div className="mx-auto max-w-5xl space-y-6 p-6">{children}</div>
    </div>
  )
}

export default async function PublicFlowSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const headerList = await headers()
  // Best-available client key for the rate limiter. Spoofable, like any
  // header-derived identity — this bounds accidental load and casual scraping,
  // not a determined attacker (whom the 128-bit token already stops).
  const clientKey =
    headerList.get('x-forwarded-for')?.split(',')[0]?.trim() || headerList.get('x-real-ip') || 'unknown'
  const result = await resolveAnonymousFlowShare(token, { clientKey })

  if (result.status === 'rate_limited') {
    return (
      <Shell>
        <div className="rounded-2xl border border-border/60 bg-card p-8 text-center shadow-1">
          <h1 className="text-lg font-semibold">Too many requests</h1>
          <p className="mt-2 text-sm text-muted-foreground">Give it a minute and try the link again.</p>
        </div>
      </Shell>
    )
  }

  if (result.status === 'not_found') {
    return (
      <Shell>
        <div className="rounded-2xl border border-border/60 bg-card p-8 text-center shadow-1">
          <h1 className="text-lg font-semibold">This link isn’t available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may have been turned off or replaced. Ask whoever sent it for a new one.
          </p>
        </div>
      </Shell>
    )
  }

  const { flow } = result
  return (
    <Shell>
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Shared flow</p>
          <h1 className="text-2xl font-bold leading-tight">{flow.name}</h1>
          {flow.description && <p className="mt-2 max-w-2xl text-muted-foreground">{flow.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" /> {flow.stepCount} step{flow.stepCount === 1 ? '' : 's'}
            </span>
            <span>Updated {new Date(flow.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        <Link
          href="/auth/login"
          className="shrink-0 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Sign in to Backstory
        </Link>
      </div>

      <section className="rounded-2xl border border-border/60 bg-card p-5 shadow-1">
        <p className="eyebrow mb-3">The shape of it</p>
        <FlowGraphPreview graph={flow.graph} />
      </section>

      <p className="flex items-start gap-2 rounded-2xl border border-border/60 bg-card p-4 text-xs text-muted-foreground shadow-1">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        This is a read-only view of how the flow is put together. Its settings, connected accounts, prompts and run
        history stay in the workspace that owns it.
      </p>
    </Shell>
  )
}
