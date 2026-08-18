'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertCircle, ArrowRight, Check, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { gateMeter } from '@/lib/onboarding/gate-meter'
import { ProposalInbox } from '@/components/onboarding/proposal-inbox'
import { isCustomerEdition } from '@/lib/edition'
import {
  onboardingStages,
  liveStageIndex,
  unlockedStage as resolveUnlockedStage,
  shouldForwardToDashboard,
} from '@/lib/onboarding/stages'

type SetupStatusState = {
  entitled: boolean
  backstoryConnected: boolean
  backstoryConnectionId: string | null
  backstoryServerUrl: string | null
  loading: boolean
}

const initialStatus: SetupStatusState = {
  entitled: false,
  backstoryConnected: false,
  backstoryConnectionId: null,
  backstoryServerUrl: null,
  loading: true,
}

type IntegrationsGate = { connected: number; required: number; meetsGate: boolean; providers: string[] }

type CatalogueRow = { id: string; name: string; type?: string; source?: string }

const oauthErrorCodes = new Set(['oauth', 'oauth_state', 'oauth_start', 'oauth_params'])

const CUSTOMER = isCustomerEdition()
const STAGES = onboardingStages()
const LIVE_STAGE = liveStageIndex()

/**
 * The entitlement gate's front door, grown into the three-step onboarding:
 * Connect your tools (entitlement + MCP + the 3-integration meter) → Your
 * data takes shape (the AI proposal inbox) → Your AI goes live (deploy from
 * the org's catalogue). Entitlement is still enforced exactly as before —
 * stages 2 and 3 only unlock behind it. Fully-onboarded visitors still
 * bounce straight to the dashboard.
 */
function ConnectInner() {
  const params = useSearchParams()
  const peopleaiStatus = params.get('peopleai')
  const connected = params.get('connected')
  const errorCode = params.get('error')

  const [status, setStatus] = useState<SetupStatusState>(initialStatus)
  const [gate, setGate] = useState<IntegrationsGate | null>(null)
  const [catalogue, setCatalogue] = useState<CatalogueRow[]>([])
  const [stage, setStage] = useState(0)
  const [openProposals, setOpenProposals] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/setup/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        if (data?.success) {
          setStatus({
            entitled: Boolean(data.entitled),
            backstoryConnected: Boolean(data.backstoryConnected),
            backstoryConnectionId: data.backstoryConnectionId ?? null,
            backstoryServerUrl: data.backstoryServerUrl ?? null,
            loading: false,
          })
        } else {
          setStatus((prev) => ({ ...prev, loading: false }))
        }
      })
      .catch(() => {
        if (!cancelled) setStatus((prev) => ({ ...prev, loading: false }))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const entitlementDone = status.entitled && status.backstoryConnected

  // Stage-1 meter + one-shot onboarding context, only once the gate is open.
  useEffect(() => {
    if (!entitlementDone) return
    let cancelled = false
    // Both of these exist to serve AI template generation — the 3-integration
    // meter gates it, the proposals ARE it. The customer edition has neither,
    // so it skips them and forwards on entitlement alone.
    if (!CUSTOMER) {
      fetch('/api/integrations/count', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!cancelled && data) setGate({ connected: data.connected ?? 0, required: data.required ?? 3, meetsGate: Boolean(data.meetsGate), providers: data.providers ?? [] })
        })
        .catch(() => {})
      fetch('/api/template-proposals', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!cancelled && data?.success) setOpenProposals(((data.proposals ?? []) as { status: string }[]).filter((p) => p.status === 'open').length)
        })
        .catch(() => {
          if (!cancelled) setOpenProposals(0)
        })
    }
    fetch('/api/agent-templates', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return
        const rows = (data?.templates ?? []) as CatalogueRow[]
        setCatalogue(rows.slice(0, 6))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [entitlementDone])

  // Fully onboarded (connected + gate met + nothing to review) → dashboard,
  // same as the old auto-redirect. Anyone mid-journey stays on the stepper.
  useEffect(() => {
    if (status.loading || !entitlementDone) return
    if (shouldForwardToDashboard({ entitlementDone, meetsGate: Boolean(gate?.meetsGate), openProposals })) {
      const timer = window.setTimeout(() => {
        window.location.assign('/dashboard')
      }, 1200)
      return () => window.clearTimeout(timer)
    }
  }, [status.loading, entitlementDone, gate?.meetsGate, openProposals])

  // The furthest stage the user may open; they can always look back.
  const unlockedStage = resolveUnlockedStage({ entitlementDone, meetsGate: Boolean(gate?.meetsGate) })
  useEffect(() => {
    setStage((current) => Math.min(Math.max(current, entitlementDone ? 1 : 0), unlockedStage))
  }, [entitlementDone, unlockedStage])

  const meter = useMemo(() => gateMeter(gate?.connected ?? 0, gate?.required ?? 3), [gate])

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-horizon-soft p-6">
      <div className="w-full max-w-xl animate-fade-in-up rounded-xl border bg-white p-8 shadow-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/backstory-lockup-black.png" alt="Backstory" className="h-6 w-auto" />

        {/* Stepper */}
        <ol className="mt-8 flex items-center gap-2">
          {STAGES.map((title, index) => {
            const reachable = index <= unlockedStage
            const active = index === stage
            return (
              <li key={title} className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => setStage(index)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                    active ? 'border-gray-900 bg-gray-900 text-white' : reachable ? 'border-gray-200 text-gray-700 hover:bg-gray-50' : 'border-gray-100 text-gray-300',
                  )}
                >
                  <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', active ? 'bg-white text-gray-900' : 'bg-gray-100 text-gray-500')}>
                    {index + 1}
                  </span>
                  <span className="truncate text-xs font-semibold">{title}</span>
                </button>
              </li>
            )
          })}
        </ol>

        {/* Connection outcome banners (unchanged behavior) */}
        {peopleaiStatus === 'error' && (
          <Banner tone="warn">The connection didn&apos;t complete. Try again — if it keeps failing, contact support.</Banner>
        )}
        {peopleaiStatus === 'team-mismatch' && (
          <Banner tone="warn">This workspace belongs to a different Backstory team. Ask your workspace admin, or sign in with the matching account.</Banner>
        )}
        {peopleaiStatus === 'state-mismatch' && <Banner tone="warn">The sign-in attempt expired. Start the connection again.</Banner>}
        {peopleaiStatus === 'connected' && <Banner tone="ok">Connected. You can head to your dashboard.</Banner>}
        {connected === '1' && <Banner tone="ok">Backstory MCP connected.</Banner>}
        {errorCode && oauthErrorCodes.has(errorCode) && (
          <Banner tone="warn">The Backstory MCP connection didn&apos;t complete. Try again.</Banner>
        )}

        {stage === 0 && (
          <section className="mt-6">
            <h1 className="text-2xl font-semibold text-gray-900">Connect your tools</h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Backstory Studio is available to Backstory Sales AI customers. Sign in with your Salesforce identity to
              link this workspace to your team — your agents will read Sales AI with your own permissions.
            </p>

            <div className="mt-6 space-y-3">
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Step 1</p>
                <p className="mt-0.5 text-sm font-semibold text-gray-900">Sales AI entitlement</p>
                {status.entitled ? (
                  <p className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700">
                    <Check className="h-4 w-4 shrink-0" /> Sales AI connected
                  </p>
                ) : (
                  <a
                    href="/api/peopleai/connect?return_to=/connect"
                    aria-disabled={status.loading}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  >
                    Connect Backstory <ArrowRight className="h-4 w-4" />
                  </a>
                )}
              </div>

              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Step 2</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900">Backstory MCP</p>
                  <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium text-gray-500">OAuth 2.0</span>
                </div>
                {status.backstoryServerUrl && (
                  <p className="mt-1 truncate text-xs text-gray-500" title={status.backstoryServerUrl}>
                    {status.backstoryServerUrl}
                  </p>
                )}
                {status.backstoryConnected ? (
                  <p className="mt-3 flex items-center gap-2 text-sm font-medium text-green-700">
                    <Check className="h-4 w-4 shrink-0" /> Backstory MCP connected
                  </p>
                ) : (
                  <a
                    href={`/api/mcp-connections/oauth/start?connectionId=${status.backstoryConnectionId ?? ''}&returnTo=/connect`}
                    aria-disabled={status.loading || !status.backstoryConnectionId}
                    className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white shadow-1 transition-all duration-fast ease-out-quart hover:bg-gray-800 hover:shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  >
                    Connect Backstory MCP <ArrowRight className="h-4 w-4" />
                  </a>
                )}
              </div>

              {entitlementDone && (
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">Step 3</p>
                  <p className="mt-0.5 text-sm font-semibold text-gray-900">Connect the tools your team works in</p>
                  {/* The meter and its copy describe AI generation, which the
                      customer edition does not have — promising it would be a
                      lie, and gating on it would block them behind a meter that
                      unlocks nothing. */}
                  {CUSTOMER ? (
                    <p className="mt-1 text-sm leading-5 text-gray-600">
                      Connect the tools your agents should work across. You can add more at any time.
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-sm leading-5 text-gray-600">
                        Once {gate?.required ?? 3} tools are connected, your AI starts learning how your team uses them and
                        drafts automations for you.
                      </p>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100">
                        <div className="h-full rounded-full bg-gray-900 transition-all" style={{ width: `${meter.percent}%` }} />
                      </div>
                      <p className="mt-1.5 text-xs font-medium text-gray-600">{meter.label}</p>
                    </>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Link
                      href="/integrations"
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                    >
                      Open integrations <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    {(CUSTOMER || meter.meetsGate) && (
                      <button
                        type="button"
                        onClick={() => setStage(CUSTOMER ? LIVE_STAGE : 1)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
                      >
                        {CUSTOMER ? 'Your AI goes live' : 'See what your AI found'} <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <p className="mt-4 text-xs leading-5 text-fg-muted">
              You&apos;ll authenticate with Salesforce through Backstory. Backstory only receives tokens scoped to your
              permissions — no passwords.
            </p>
          </section>
        )}

        {!CUSTOMER && stage === 1 && (
          <section className="mt-6">
            <h1 className="text-2xl font-semibold text-gray-900">Your data takes shape</h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {gate?.providers?.length
                ? `Analyzing how your team uses ${gate.providers.slice(0, 3).join(', ')}${gate.providers.length > 3 ? ' and more' : ''}…`
                : 'Analyzing how your team uses its connected tools…'}{' '}
              Review what it proposes — accept what looks right, dismiss the rest.
            </p>
            <div className="mt-5">
              <ProposalInbox generating={Boolean(gate?.meetsGate)} />
            </div>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setStage(LIVE_STAGE)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800"
              >
                Your AI goes live <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </section>
        )}

        {stage === LIVE_STAGE && (
          <section className="mt-6">
            <h1 className="text-2xl font-semibold text-gray-900">Your AI goes live</h1>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              Deploy from your catalogue — what you accepted is at the top, ready to run with your data.
            </p>
            {catalogue.length > 0 ? (
              <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                {catalogue.map((template) => (
                  <li key={template.id}>
                    <Link href={`/templates/${template.id}`} className="flex h-full flex-col rounded-lg border p-3 hover:bg-gray-50">
                      <span className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-700">
                        <Sparkles className="h-3 w-3" />
                        {template.source === 'ai_generated' ? 'Made for your team' : template.type || 'Template'}
                      </span>
                      <span className="mt-1 text-sm font-semibold text-gray-900">{template.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-gray-500">Your catalogue is loading…</p>
            )}
            <div className="mt-5 flex justify-end">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
              >
                Open your workspace <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  )
}

function Banner({ tone, children }: { tone: 'ok' | 'warn'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm',
        tone === 'ok' ? 'border-green-200 bg-green-50 text-green-900' : 'border-amber-200 bg-amber-50 text-amber-900',
      )}
    >
      {tone === 'ok' ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
      <p>{children}</p>
    </div>
  )
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectInner />
    </Suspense>
  )
}
