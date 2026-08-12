'use client'

/**
 * Settings → work orphaned by deprovisioning.
 *
 * When someone is deprovisioned their credentials are revoked, and the flows
 * and agents they owned are quarantined rather than deleted or silently handed
 * to whoever the scheduler picked next. Other teams often depend on that work,
 * so the stoppage has to be VISIBLE and one click from repair — otherwise a
 * security fix reads as an unexplained outage.
 *
 * Claiming rebinds the work to you: it resumes under your identity and your
 * credentials, which is the only attribution that is honest after the original
 * owner is gone.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

type QuarantinedRow = {
  kind: 'flow' | 'agent'
  id: string
  name: string
  quarantinedAt: string
  formerOwnerEmail: string | null
}

export function QuarantinePanel() {
  const [items, setItems] = useState<QuarantinedRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [claiming, setClaiming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/quarantine')
      if (!response.ok) return
      const data = await response.json()
      setItems(data.items ?? [])
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const claim = async (row: QuarantinedRow) => {
    setClaiming(row.id)
    try {
      const response = await fetch(`/api/quarantine/${row.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: row.kind }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Could not claim it')
      }
      toast.success(`You now own “${row.name}”. It runs with your credentials.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not claim that. Try again.')
    } finally {
      setClaiming(null)
      await load()
    }
  }

  // An exception surface: a permanent empty card is noise on a page nobody
  // visits looking for it.
  if (!loaded || items.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Work that needs an owner</CardTitle>
        <CardDescription>
          These stopped when the person who owned them was removed. Claiming one starts it running again under
          your account, using your connected credentials.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((row) => (
          <div
            key={`${row.kind}:${row.id}`}
            className="flex items-center justify-between gap-4 rounded-lg border p-3"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{row.name}</p>
              <p className="text-sm text-muted-foreground">
                {row.kind === 'flow' ? 'Flow' : 'Agent'}
                {row.formerOwnerEmail ? ` · previously ${row.formerOwnerEmail}` : ''}
                {` · stopped ${new Date(row.quarantinedAt).toLocaleDateString()}`}
              </p>
            </div>
            <Button onClick={() => claim(row)} disabled={claiming === row.id}>
              {claiming === row.id ? 'Claiming…' : 'Claim'}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
