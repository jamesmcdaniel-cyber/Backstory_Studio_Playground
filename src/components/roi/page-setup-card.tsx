'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Bot, CircleCheck, Database, Loader2, Plug, Workflow } from 'lucide-react'
import { toast } from 'sonner'
import { apiErrorMessage } from '@/lib/roi/history'
import type { RoiPageSetup } from '@/lib/roi/types'

type DataSource = RoiPageSetup['dataSource']

const EYEBROW = 'font-mono text-[11px] uppercase tracking-wider text-muted-foreground'

/**
 * What stands behind the page: the private admin agent that runs every
 * analysis, where a run's data comes from (an admin can switch it to a data
 * flow), and whether the analyst can add account context from Backstory.
 */
export function PageSetupCard({ setup, onDataSourceChange }: { setup: RoiPageSetup; onDataSourceChange: (dataSource: DataSource) => void }) {
  const { agent, dataSource, flows, backstory } = setup
  const [saving, setSaving] = useState(false)
  const sourceLabel = dataSource.kind === 'flow' ? `${dataSource.flowName ?? 'Data'} flow` : 'Loaded extracts'

  const chooseFlow = async (flowId: string) => {
    const next = flowId || null
    if (next === dataSource.flowId) return
    setSaving(true)
    try {
      const response = await fetch('/api/roi/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataFlowId: next }),
      })
      const data = await response.json().catch(() => ({})) as { dataSource?: DataSource }
      if (!response.ok) throw new Error(apiErrorMessage(data, 'The data source could not be changed.'))
      const flow = flows.find((candidate) => candidate.id === next)
      onDataSourceChange(data.dataSource ?? (flow ? { kind: 'flow', flowId: flow.id, flowName: flow.name } : { kind: 'repository', flowId: null, flowName: null }))
      toast.success(next ? `Runs now fetch their data with the ${flow?.name ?? 'chosen'} flow.` : 'Runs now read the loaded extracts.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside aria-label="How this page runs" className="space-y-4 rounded-xl border bg-card p-5 text-sm shadow-1">
      <div>
        <p className={EYEBROW}>Powered by</p>
        <div className="mt-1 flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1.5 font-medium"><Bot className="h-4 w-4 shrink-0 text-horizon-600" aria-hidden /><span className="truncate">{agent.title}</span></p>
          {agent.canConfigure && agent.id && (
            <Link href={`/agents?agent=${agent.id}`} className="shrink-0 rounded text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Configure</Link>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A private admin agent{agent.model ? ` · ${agent.model}` : ''}{agent.ownerName ? ` · owned by ${agent.ownerName}` : ''}
        </p>
      </div>

      <div className="border-t pt-4">
        <p className={EYEBROW}>Data source</p>
        <p className="mt-1 flex items-center gap-1.5 font-medium">
          {dataSource.kind === 'flow' ? <Workflow className="h-4 w-4 text-horizon-600" aria-hidden /> : <Database className="h-4 w-4 text-horizon-600" aria-hidden />}
          {sourceLabel}
        </p>
        {flows.length > 0 ? (
          <div className="mt-2.5">
            <label htmlFor="roi-data-flow" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Data flow{saving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            </label>
            <select
              id="roi-data-flow"
              value={dataSource.flowId ?? ''}
              disabled={saving}
              onChange={(event) => void chooseFlow(event.target.value)}
              aria-describedby="roi-data-flow-help"
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm transition-colors hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <option value="">None — use the loaded extracts</option>
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.published ? flow.name : `${flow.name} (not published)`}</option>)}
            </select>
            <p id="roi-data-flow-help" className="mt-1.5 text-xs text-muted-foreground">The flow fetches the account's data from the warehouse and hands it to the analyst.</p>
          </div>
        ) : agent.canConfigure ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            A data flow can fetch each account's data from the warehouse and hand it to the analyst. <Link href="/flows" className="font-medium text-horizon-700 hover:underline">Build one in Flows</Link>, then choose it here.
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {dataSource.kind === 'flow' ? "The flow fetches the account's data from the warehouse and hands it to the analyst." : "Runs read the account's extracts loaded into the Repository."}
          </p>
        )}
      </div>

      <div className="border-t pt-4">
        <p className={EYEBROW}>Backstory</p>
        {backstory.connected ? (
          <p className="mt-1 flex items-start gap-1.5"><CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />Connected — the analyst adds account context from Backstory</p>
        ) : (
          <>
            <p className="mt-1 text-muted-foreground">Not connected. The analysis runs on the account's data alone.</p>
            <Link href="/connect" className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-horizon-700 hover:underline">
              <Plug className="h-3.5 w-3.5" aria-hidden />Connect Backstory
            </Link>
          </>
        )}
      </div>
    </aside>
  )
}
