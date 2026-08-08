'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'motion/react'
import { Check, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react'
import { GoogleButton } from '@/components/auth/google-button'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { validatedReturnPath } from '@/lib/auth/return-path'

const traceRows = [
  { label: 'Account signals', detail: 'Connected', delay: 0.55 },
  { label: 'Agent workspace', detail: 'Ready', delay: 0.68 },
  { label: 'Run history', detail: 'Auditable', delay: 0.81 },
]

function safeReturnTo(): string {
  if (typeof window === 'undefined') return '/dashboard'
  const raw = new URLSearchParams(window.location.search).get('return_to')
  return validatedReturnPath(raw) || '/dashboard'
}

export function AuthGateway() {
  const { user, loading: authLoading, signInWithSSO } = useSupabase()
  const router = useRouter()
  const [ssoDomain, setSsoDomain] = useState('')
  const [ssoLoading, setSsoLoading] = useState(false)
  // Set when the auth callback bounced a sign-in because the org enforces SSO:
  // ?sso_required=<domain>. The domain is prefilled so one click resumes
  // through the identity provider.
  const [ssoRequired, setSsoRequired] = useState(false)

  useEffect(() => {
    const required = new URLSearchParams(window.location.search).get('sso_required')
    if (!required) return
    setSsoRequired(true)
    if (required.includes('.')) setSsoDomain(required)
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const tokenHash = params.get('token_hash')
    const type = params.get('type')

    // Preserve support for older verification links that landed on the login
    // screen instead of the auth callback.
    if (tokenHash && type) {
      const callbackUrl = new URL('/auth/callback', window.location.origin)
      callbackUrl.searchParams.set('token_hash', tokenHash)
      callbackUrl.searchParams.set('type', type)
      const returnTo = params.get('return_to')
      if (returnTo) callbackUrl.searchParams.set('next', returnTo)
      window.location.replace(callbackUrl.toString())
      return
    }

    if (!authLoading && user) router.replace(safeReturnTo())
  }, [authLoading, router, user])

  return (
    <TooltipProvider delayDuration={250}>
      <div className="min-h-screen bg-graphite-950 p-2 sm:p-3 lg:h-screen lg:p-4">
        <main className="mx-auto grid min-h-[calc(100vh-1rem)] max-w-[1800px] overflow-hidden rounded-[26px] border border-white/10 bg-white shadow-[0_30px_100px_rgba(0,0,0,0.42)] sm:min-h-[calc(100vh-1.5rem)] lg:h-[calc(100vh-2rem)] lg:min-h-[680px] lg:grid-cols-[1.06fr_0.94fr]">
          <section className="auth-grid relative hidden overflow-hidden bg-graphite-950 px-10 py-9 text-white lg:flex lg:flex-col xl:px-16 xl:py-12">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_35%,rgba(68,124,147,0.48),transparent_36%),radial-gradient(circle_at_75%_88%,rgba(43,97,120,0.4),transparent_34%)]" />
            <motion.div
              aria-hidden="true"
              className="absolute -bottom-36 right-[-8%] h-[34rem] w-[34rem] rounded-full bg-horizon-500/25 blur-[90px]"
              animate={{ x: [0, -24, 0], y: [0, -18, 0], scale: [1, 1.08, 1] }}
              transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
            />

            <motion.div
              className="relative z-10"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/backstory-lockup-white.png" alt="Backstory" className="h-6 w-auto" />
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.24em] text-horizon-200">
                Intelligence workspace
              </p>
            </motion.div>

            <div className="relative z-10 my-auto max-w-2xl py-14">
              <motion.div
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12, duration: 0.55 }}
              >
                <p className="mb-5 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-horizon-200">
                  <Sparkles className="h-4 w-4" />
                  Your operational story, in focus
                </p>
                <h1 className="max-w-xl text-5xl font-medium leading-[1.03] tracking-[-0.04em] xl:text-6xl">
                  See what&apos;s coming.
                  <span className="mt-1 block text-horizon-200">Know what to do.</span>
                </h1>
                <p className="mt-7 max-w-lg text-lg leading-8 text-white/60">
                  Build, run, and review intelligent workflows with every decision and tool call in plain sight.
                </p>
              </motion.div>

              <motion.div
                className="mt-12 max-w-lg rounded-2xl border border-white/10 bg-white/[0.065] p-2 shadow-2xl backdrop-blur-xl"
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: 0.35, duration: 0.55 }}
              >
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/45">
                    Workspace status
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-horizon-100">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                    Ready
                  </span>
                </div>
                <div className="space-y-1">
                  {traceRows.map((row) => (
                    <motion.div
                      key={row.label}
                      className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/15 px-3.5 py-3"
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: row.delay, duration: 0.35 }}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-horizon-400/20 text-horizon-100">
                        <Check className="h-3.5 w-3.5" />
                      </span>
                      <span className="flex-1 text-sm text-white/80">{row.label}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-white/40">{row.detail}</span>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            </div>

            <div className="relative z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">
              <span>Private workspace</span>
              <span>Identity protected by SSO</span>
            </div>
          </section>

          <section className="relative flex min-h-[calc(100vh-1rem)] items-center overflow-hidden bg-[#fcfbf9] px-6 py-12 sm:min-h-[calc(100vh-1.5rem)] sm:px-12 lg:min-h-0 lg:px-16 xl:px-24">
            <div aria-hidden="true" className="absolute right-0 top-0 h-72 w-72 -translate-y-1/3 translate-x-1/3 rounded-full bg-horizon-100/70 blur-3xl" />
            <motion.div
              className="relative mx-auto w-full max-w-xl"
              initial={{ opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.16, duration: 0.5 }}
            >
              <div className="mb-14 flex items-center gap-3 lg:mb-20">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl border bg-white shadow-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/backstory-symbol-black.png" alt="" className="h-6 w-6 object-contain" />
                </span>
                <div>
                  <p className="font-mono text-[11px] font-bold uppercase tracking-[0.22em] text-graphite-800">
                    Backstory Studio
                  </p>
                  <p className="mt-1 text-sm text-graphite-500">Secure workspace access</p>
                </div>
              </div>

              <div>
                <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-horizon-600">
                  Welcome back
                </p>
                <h2 className="text-4xl font-semibold leading-[1.08] tracking-[-0.035em] text-graphite-900 sm:text-5xl">
                  Pick up where
                  <span className="block text-graphite-500">you left off.</span>
                </h2>
                <p className="mt-5 max-w-md text-base leading-7 text-graphite-600">
                  Continue with your company Google account, or through your organization&apos;s identity provider below.
                </p>
              </div>

              {ssoRequired && (
                <div role="alert" className="mt-6 rounded-xl border border-amber-300/70 bg-amber-50/70 px-4 py-3 text-sm text-amber-900">
                  Your organization requires signing in through its identity provider (SSO).
                  {ssoDomain ? ' Continue below to go through it.' : ' Enter your company domain below to continue.'}
                </div>
              )}

              <div className="mt-10">
                {authLoading ? (
                  <Button disabled loading variant="outline" className="h-14 w-full rounded-xl text-base">
                    Checking session…
                  </Button>
                ) : (
                  <GoogleButton
                    label="Continue with Google"
                    className="h-14 rounded-xl border-graphite-200 bg-white text-base font-semibold shadow-2 hover:border-horizon-200 hover:bg-white hover:shadow-3 [&_svg]:size-5"
                  />
                )}
              </div>

              <div className="my-5 flex items-center gap-3 text-xs text-graphite-400">
                <span className="h-px flex-1 bg-graphite-200" /> Enterprise SSO <span className="h-px flex-1 bg-graphite-200" />
              </div>
              <form
                className="flex gap-2"
                onSubmit={async (event) => {
                  event.preventDefault()
                  if (!ssoDomain.trim()) return
                  setSsoLoading(true)
                  const { error } = await signInWithSSO(ssoDomain, safeReturnTo())
                  if (error) setSsoLoading(false)
                }}
              >
                <input
                  aria-label="Company domain"
                  value={ssoDomain}
                  onChange={(event) => setSsoDomain(event.target.value)}
                  placeholder="company.com"
                  className="h-12 min-w-0 flex-1 rounded-xl border border-graphite-200 bg-white px-4 text-sm outline-none focus:border-horizon-500"
                />
                <Button type="submit" variant="outline" loading={ssoLoading} disabled={!ssoDomain.trim()}>Continue</Button>
              </form>

              <div className="mt-6 flex flex-wrap items-center gap-2">
                <span className="text-xs text-graphite-500">Approved accounts:</span>
                {['people.ai', 'backstory.ai'].map((domain) => (
                  <Tooltip key={domain}>
                    <TooltipTrigger asChild>
                      <span className="cursor-help rounded-full border border-graphite-200 bg-white px-3 py-1 font-mono text-[11px] text-graphite-700 shadow-1">
                        @{domain}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Managed company identity</TooltipContent>
                  </Tooltip>
                ))}
              </div>

              <div className="mt-10 grid gap-3 border-t border-graphite-200 pt-6 sm:grid-cols-2">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 text-horizon-600" />
                  <div>
                    <p className="text-sm font-medium text-graphite-800">Company SSO</p>
                    <p className="mt-0.5 text-xs leading-5 text-graphite-500">Okta and SAML policies are enforced at sign-in.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <LockKeyhole className="mt-0.5 h-4 w-4 text-horizon-600" />
                  <div>
                    <p className="text-sm font-medium text-graphite-800">Scoped workspace</p>
                    <p className="mt-0.5 text-xs leading-5 text-graphite-500">Runs and connections remain private.</p>
                  </div>
                </div>
              </div>

              <footer className="mt-12 flex items-center gap-4 text-xs text-graphite-500">
                <span>By continuing, you agree to our</span>
                <Link href="/privacy" className="transition-colors hover:text-graphite-900 hover:underline">Privacy</Link>
                <Link href="/terms" className="transition-colors hover:text-graphite-900 hover:underline">Terms</Link>
              </footer>
            </motion.div>
          </section>
        </main>
      </div>
    </TooltipProvider>
  )
}
