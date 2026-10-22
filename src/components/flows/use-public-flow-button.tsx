'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * "Use this flow" on a public flow link: copies the flow into the visitor's
 * own workspace as a private draft and opens it. The copy carries no saved
 * credentials, workspace ids or sample data, and nothing links it back to the
 * original. Rendered only for a signed-in visitor on a link whose owner offers
 * copies; everyone else gets a sign-in link instead.
 */
export function UsePublicFlowButton({ token }: { token: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/share/flows/${encodeURIComponent(token)}/copy`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.flowId) {
        setError(data.error || 'The flow could not be copied. Try again.')
        return
      }
      router.push(`/flows/${data.flowId}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
      <Button onClick={() => void copy()} loading={busy}>
        {!busy && <Copy className="mr-1.5 h-4 w-4" />}
        Use this flow
      </Button>
      {error ? (
        <p role="alert" className="max-w-xs text-xs text-destructive">{error}</p>
      ) : (
        <p className="max-w-xs text-xs text-fg-muted">Adds a private copy to your workspace. Connect your own accounts before running it.</p>
      )}
    </div>
  )
}
