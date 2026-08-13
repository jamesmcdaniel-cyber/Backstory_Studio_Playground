'use client'

/**
 * Where a password recovery link lands.
 *
 * The link goes to /auth/callback, which exchanges the recovery token for a
 * session and forwards here — so by the time this renders the visitor is signed
 * in and updateUser is all that remains. Two consequences worth knowing:
 *
 *   - middleware exempts this path from the "signed-in users leave auth pages"
 *     redirect, or the reset link would bounce straight to the dashboard
 *   - arriving here WITHOUT a recovery session is possible (someone bookmarks
 *     it), so the failure is handled rather than assumed away
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/enterprise-policy'

const MIN_LENGTH = MIN_PASSWORD_LENGTH

export default function UpdatePasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)

  const tooShort = password.length > 0 && password.length < MIN_LENGTH
  const mismatched = confirmation.length > 0 && password !== confirmation
  const submittable = password.length >= MIN_LENGTH && password === confirmation && !saving

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!submittable) return
    setSaving(true)
    try {
      const { error } = await createClient().auth.updateUser({ password })
      if (error) {
        // Overwhelmingly this is an expired or already-used recovery link.
        toast.error(
          error.message.toLowerCase().includes('session')
            ? 'That reset link has expired. Ask for a new one.'
            : error.message,
        )
        return
      }
      toast.success('Password updated.')
      router.replace('/dashboard')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-sm flex-col justify-center">
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        At least {MIN_LENGTH} characters. You will stay signed in on this device.
      </p>

      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {tooShort && <p className="text-xs text-destructive">Use at least {MIN_LENGTH} characters.</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirmation">Confirm password</Label>
          <Input
            id="confirmation"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
          {mismatched && <p className="text-xs text-destructive">Those do not match.</p>}
        </div>

        <Button type="submit" className="w-full" disabled={!submittable}>
          {saving ? 'Saving…' : 'Update password'}
        </Button>
      </form>
    </div>
  )
}
