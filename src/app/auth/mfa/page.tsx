'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSupabase } from '@/components/providers/supabase-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function MfaPage() {
  const { user, loading, mfa } = useSupabase()
  const router = useRouter()
  const [factorId, setFactorId] = useState('')
  const [qr, setQr] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.replace('/auth/login')
  }, [loading, router, user])

  const enroll = async () => {
    setBusy(true)
    const { data, error } = await mfa.enroll({ factorType: 'totp', friendlyName: 'Backstory Studio' })
    setBusy(false)
    if (error) return toast.error(error.message)
    setFactorId(data.id)
    setQr(data.totp.qr_code)
    setSecret(data.totp.secret)
  }

  const verify = async () => {
    setBusy(true)
    const challenge = await mfa.challenge({ factorId })
    if (challenge.error) { setBusy(false); return toast.error(challenge.error.message) }
    const result = await mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() })
    setBusy(false)
    if (result.error) return toast.error(result.error.message)
    toast.success('Multi-factor authentication enabled.')
    router.replace('/dashboard')
    router.refresh()
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Secure your account</h1>
        <p className="mt-2 text-sm text-muted-foreground">Your workspace requires a verified authenticator before access is granted.</p>
      </div>
      {!factorId ? (
        <Button onClick={enroll} loading={busy} disabled={!user}>Set up authenticator</Button>
      ) : (
        <div className="space-y-4">
          {/* Supabase returns a data URL generated for this enrollment. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="Authenticator QR code" className="mx-auto h-56 w-56 rounded border bg-white p-3" />
          <p className="break-all rounded bg-muted p-3 font-mono text-xs">{secret}</p>
          <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="6-digit code" />
          <Button className="w-full" onClick={verify} loading={busy} disabled={code.trim().length < 6}>Verify and continue</Button>
        </div>
      )}
    </main>
  )
}
