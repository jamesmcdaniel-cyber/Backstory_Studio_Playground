'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

export function UseTemplateButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function openCopy() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/share/artifacts/${encodeURIComponent(token)}/copy`, { method: 'POST' })
      if (response.status === 401) {
        window.location.assign(`/auth/login?return_to=${encodeURIComponent(`/share/artifact/${token}`)}`)
        return
      }
      const data = await response.json()
      if (!response.ok || typeof data.artifactId !== 'string') throw new Error(data.error || 'Could not create your copy. Please try again.')
      window.location.assign(`/artifacts/${encodeURIComponent(data.artifactId)}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create your copy.')
      setBusy(false)
    }
  }
  return <div className="max-w-sm space-y-1 text-right">
    <Button disabled={busy} onClick={() => void openCopy()}>{busy ? 'Opening your copy…' : 'Use template with AI Copilot'}</Button>
    <p className="text-xs text-muted-foreground">Opens your own copy. The original stays unchanged. Sign-in required.</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
