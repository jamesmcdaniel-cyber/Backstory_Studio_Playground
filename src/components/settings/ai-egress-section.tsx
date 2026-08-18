'use client'

/**
 * The workspace AI switch.
 *
 * `aiEgressPolicy` existed on the workspace and was enforced on every model
 * call, but nothing in the product could set it — while the refusal it produces
 * told people "an administrator can turn it back on in Settings". This is that
 * control.
 *
 * The copy deliberately says what HAPPENS ("agents and flows stop running")
 * rather than what it is called. A person turning this on is usually answering a
 * legal question — a data-processing agreement that forbids sending customer
 * data to a model provider — and needs to know the operational cost of the
 * answer before they commit to it, not the name of the column.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Section } from '@/components/settings/section'
import { SettingsRow } from '@/components/settings/dialogs'

type Policy = 'allowed' | 'blocked'

export function AiEgressSection() {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await fetch('/api/organizations/ai-policy', { cache: 'no-store' })
      .then((response) => response.json())
      .catch(() => null)
    if (data?.success) setPolicy(data.aiEgressPolicy as Policy)
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])

  const update = async (next: Policy) => {
    setBusy(true)
    try {
      const response = await fetch('/api/organizations/ai-policy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiEgressPolicy: next }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) return toast.error(data.error || 'Could not save that setting.')
      setPolicy(data.aiEgressPolicy as Policy)
      toast.success(next === 'blocked' ? 'AI features are now switched off for this workspace.' : 'AI features are back on.')
    } finally { setBusy(false) }
  }

  const blocked = policy === 'blocked'

  return (
    <Section
      title="AI processing"
      description="Whether this workspace is allowed to send its data to an AI model provider."
    >
      <SettingsRow
        title="Allow AI features"
        description={
          blocked
            ? 'Switched off. Agents and flows that use AI stop before sending anything, and the copilots and chat answer with a short note explaining why. Everything else keeps working.'
            : 'On. Agents, flows, the copilots and chat send the text they work on to the model provider. Turn this off if your agreement with a customer does not allow that — nothing is sent while it is off.'
        }
      >
        <Switch
          checked={!blocked}
          disabled={!loaded || busy}
          aria-label="Allow AI features"
          onCheckedChange={(checked) => void update(checked ? 'allowed' : 'blocked')}
        />
      </SettingsRow>
    </Section>
  )
}
