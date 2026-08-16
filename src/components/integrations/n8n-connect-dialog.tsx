'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Connect a personal n8n instance so pasting its workflow URLs "just works".
 *
 * This is a thin preset over the ordinary HTTP-credential store — the result
 * IS an HttpCredential (authType `header`, host-bound to the instance), so it
 * inherits encryption, ownership, audit, rotation and revocation without a
 * parallel path. The dialog exists because the generic credential form asks
 * for a header NAME, and nobody should need to know that n8n's is
 * X-N8N-API-KEY; here they paste two things they can see in their n8n.
 *
 * Verification is live and specific: the create endpoint probes
 * /api/v1/workflows?limit=1, which answers 401 without a valid key — so a
 * saved n8n connection is one that has already worked once.
 */
export function N8nConnectDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [instanceUrl, setInstanceUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    let host: string
    try {
      const parsed = new URL(instanceUrl.trim().startsWith('http') ? instanceUrl.trim() : `https://${instanceUrl.trim()}`)
      host = parsed.hostname.toLowerCase()
    } catch {
      toast.error('Enter your n8n address, like your-team.app.n8n.cloud')
      return
    }
    if (!apiKey.trim()) {
      toast.error('Paste the API key from n8n → Settings → API.')
      return
    }

    setSaving(true)
    try {
      const response = await fetch('/api/http-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `n8n — ${host}`,
          authType: 'header',
          // The cheapest authenticated read the n8n API has: 401 without a
          // valid key, so saving proves the key works against THIS instance.
          url: `https://${host}/api/v1/workflows?limit=1`,
          method: 'GET',
          config: { name: 'X-N8N-API-KEY', value: apiKey.trim() },
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        toast.error(data.error || 'Could not verify that key against your n8n.')
        return
      }
      toast.success(`n8n connected — paste any ${host} workflow URL into Import.`)
      setInstanceUrl('')
      setApiKey('')
      onOpenChange(false)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect your n8n</DialogTitle>
          <DialogDescription>
            After this, pasting any workflow link from your n8n into Import brings it straight in —
            no downloading JSON. Create a key in n8n under Settings → API.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="n8n-instance" className="mb-1 block text-sm font-medium">
              Your n8n address
            </label>
            <input
              id="n8n-instance"
              value={instanceUrl}
              onChange={(event) => setInstanceUrl(event.target.value)}
              placeholder="your-team.app.n8n.cloud"
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="n8n-api-key" className="mb-1 block text-sm font-medium">
              API key
            </label>
            <input
              id="n8n-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="n8n_api_…"
              autoComplete="off"
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Stored encrypted and only ever sent to {instanceUrl.trim() ? instanceUrl.trim() : 'your n8n'} — like every
              credential here, you can rotate or remove it any time.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            Verify &amp; connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
