'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSupabase } from '@/components/providers/supabase-provider'
import { emailDomain } from '@/lib/auth/enterprise-policy'
import { splitTotpFactors } from '@/lib/auth/mfa-factors'
import { isCompanyEmail } from '@/lib/auth/company-domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Supabase has returned this both ways across versions: a ready data URL and
 * raw `<svg …>` markup. An `<img src>` given raw markup renders nothing — the
 * enrollment QR was a blank box — so wrap whatever is not already a data URL.
 */
function qrImageSrc(qr: string): string {
  return qr.startsWith('data:') ? qr : `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`
}

export default function MfaPage() {
  const { user, loading, mfa, signInWithGoogle, signInWithSSO } = useSupabase()
  const router = useRouter()
  const [factorId, setFactorId] = useState('')
  const [qr, setQr] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [ssoBusy, setSsoBusy] = useState(false)
  // Someone who is ALREADY enrolled and lands here is being asked to step up to
  // aal2, not to enroll: their session is aal1 (a fresh password sign-in, or a
  // refresh that dropped the MFA leg). The page used to call enroll() for them
  // unconditionally, which Supabase refuses because a factor exists — the whole
  // required-MFA gate dead-ended in a raw error toast with no way forward.
  const [mode, setMode] = useState<'loading' | 'enroll' | 'challenge'>('loading')
  const domain = emailDomain(user?.email)
  const company = isCompanyEmail(user?.email)

  useEffect(() => {
    if (!loading && !user) router.replace('/auth/login')
  }, [loading, router, user])

  const inspectFactors = useCallback(async () => {
    const { data, error } = await mfa.listFactors()
    if (error) return { verified: [], stale: [] }
    return splitTotpFactors(data?.all ?? data?.totp ?? [])
  }, [mfa])

  useEffect(() => {
    if (loading || !user) return
    let cancelled = false
    void inspectFactors().then(({ verified }) => {
      if (cancelled) return
      if (verified.length > 0) {
        setFactorId(verified[0].id)
        setMode('challenge')
      } else {
        setMode('enroll')
      }
    })
    return () => { cancelled = true }
  }, [inspectFactors, loading, user])

  // Direct Okta SAML by domain. Company accounts fall back to Google (itself
  // Okta-federated at the Workspace layer) until the Okta<->Supabase SAML
  // connection is registered (docs/okta-saml-setup.md), so this path never
  // dead-ends.
  const continueWithOkta = async () => {
    if (!domain) return
    setSsoBusy(true)
    const { error } = await signInWithSSO(domain, '/dashboard')
    if (!error) return
    if (!company) {
      setSsoBusy(false)
      toast.error(error.message)
      return
    }
    toast.info('Okta SSO is not connected yet — continuing with Google.')
    const fallback = await signInWithGoogle('/dashboard')
    if (fallback.error) {
      setSsoBusy(false)
      toast.error(fallback.error.message)
    }
  }

  const enroll = async () => {
    setBusy(true)
    // Abandoned enrollment debris (someone scanned nothing and closed the tab)
    // leaves an unverified factor, and Supabase refuses a fresh enroll while one
    // exists. That surfaced as a raw error toast on a page whose only button was
    // the one that had just failed — permanently, since nothing ever cleaned the
    // stale factor up. Clear it and try once more rather than reporting it.
    let result = await mfa.enroll({ factorType: 'totp', friendlyName: 'Backstory Studio' })
    if (result.error) {
      const { stale } = await inspectFactors()
      if (stale.length > 0) {
        for (const factor of stale) await mfa.unenroll({ factorId: factor.id })
        result = await mfa.enroll({ factorType: 'totp', friendlyName: 'Backstory Studio' })
      }
    }
    setBusy(false)
    if (result.error) return toast.error(result.error.message)
    setFactorId(result.data.id)
    setQr(result.data.totp.qr_code)
    setSecret(result.data.totp.secret)
  }

  const verify = async () => {
    setBusy(true)
    const challenge = await mfa.challenge({ factorId })
    if (challenge.error) { setBusy(false); return toast.error(challenge.error.message) }
    const result = await mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() })
    setBusy(false)
    if (result.error) return toast.error(result.error.message)
    toast.success(mode === 'challenge' ? 'Verified.' : 'Multi-factor authentication enabled.')
    router.replace('/dashboard')
    router.refresh()
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {mode === 'challenge' ? 'Verify it’s you' : 'Secure your account'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === 'challenge'
            ? 'Enter the current code from the authenticator app already on your account. Lost the device? Ask a platform administrator to reset it for you.'
            : 'Your account requires a second factor before access is granted. Signing in through your organization’s identity provider counts — Okta enforces MFA for you.'}
        </p>
      </div>
      {domain && (
        <div className="space-y-3">
          <Button className="w-full" onClick={continueWithOkta} loading={ssoBusy} disabled={!user}>
            {company ? 'Verify with Okta' : `Sign in with your identity provider (${domain})`}
          </Button>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or use an authenticator app <span className="h-px flex-1 bg-border" />
          </div>
        </div>
      )}
      {mode === 'loading' ? (
        <div className="h-10 animate-pulse rounded-lg border bg-muted/40" />
      ) : mode === 'enroll' && !factorId ? (
        <Button variant={domain ? 'outline' : 'default'} onClick={enroll} loading={busy} disabled={!user}>
          Set up authenticator
        </Button>
      ) : (
        <div className="space-y-4">
          {/* An existing factor has no QR to show: the app is already paired, so
              the only thing missing is the current code. */}
          {mode === 'enroll' && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qrImageSrc(qr)} alt="Authenticator QR code" className="mx-auto h-56 w-56 rounded border bg-white p-3" />
              <p className="text-center text-xs text-muted-foreground">
                Scan with Google Authenticator, LastPass Authenticator, or any TOTP app — or enter the key below manually.
              </p>
              <p className="break-all rounded bg-muted p-3 font-mono text-xs">{secret}</p>
            </>
          )}
          <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6-digit code" />
          <Button className="w-full" onClick={verify} loading={busy} disabled={code.trim().length < 6}>Verify and continue</Button>
        </div>
      )}
    </main>
  )
}
