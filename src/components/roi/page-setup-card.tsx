'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Bot, CircleCheck, Database, Loader2, Plug, Workflow, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { apiErrorMessage } from '@/lib/roi/history'
import type { RoiPageSetup } from '@/lib/roi/types'

type DataSource = RoiPageSetup['dataSource']

const LINK = 'rounded text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * What stands behind the page, as a compact list: the private admin agent
 * that runs every analysis, where a run's data comes from (an admin can
 * switch it to a data flow), and whether the analyst can add account context
 * from Backstory.
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
      toast.error(error instanceof TypeError ? 'The page could not reach the server. Check your connection and try again.' : error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ul aria-label="How this page runs" className="divide-y divide-border overflow-hidden rounded-lg border bg-card text-sm">
      <SetupRow
        icon={Bot}
        label="Analyst"
        action={agent.canConfigure && agent.id ? <Link href={`/agents?agent=${agent.id}`} className={LINK}>Configure<span className="sr-only"> the analyst</span></Link> : null}
      >
        <p className="truncate font-medium" title={agent.title}>{agent.title}</p>
        <p className="text-xs text-muted-foreground">
          Private admin agent{agent.model ? ` · ${agent.model}` : ''}{agent.ownerName ? ` · owned by ${agent.ownerName}` : ''}
        </p>
      </SetupRow>

      <SetupRow icon={dataSource.kind === 'flow' ? Workflow : Database} label="Data source">
        <p className="truncate font-medium" title={sourceLabel}>{sourceLabel}</p>
        {flows.length > 0 ? (
          <div className="mt-1.5">
            <label htmlFor="roi-data-flow" className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Data flow{saving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            </label>
            <select
              id="roi-data-flow"
              value={dataSource.flowId ?? ''}
              disabled={saving}
              onChange={(event) => void chooseFlow(event.target.value)}
              aria-describedby="roi-data-flow-help"
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs transition-colors duration-fast hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <option value="">None — use the loaded extracts</option>
              {flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.published ? flow.name : `${flow.name} (not published)`}</option>)}
            </select>
            <p id="roi-data-flow-help" className="mt-1 text-xs text-muted-foreground">The flow fetches the account's data from the warehouse and hands it to the analyst. An n8n workflow works too: <Link href="/flows" className={LINK}>import it in Flows</Link> (Import, from a URL or a JSON file), then choose it here. Any flow can also load extracts on its own schedule with the ROI plane's load-extract step; the page reads the newest extract per account as soon as it lands.</p>
          </div>
        ) : agent.canConfigure ? (
          <p className="text-xs text-muted-foreground">
            A data flow can fetch each account's data from the warehouse. <Link href="/flows" className={LINK}>Build one in Flows</Link> (start from the ROI data pull templates), or import an n8n workflow there (Import, from a URL or a JSON file), then choose it here.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {dataSource.kind === 'flow' ? "The flow fetches the account's data from the warehouse and hands it to the analyst." : "Runs read the account's extracts loaded into the Repository."}
          </p>
        )}
      </SetupRow>

      <SetupRow
        icon={backstory.connected ? CircleCheck : Plug}
        iconClassName={backstory.connected ? 'text-green-600' : 'text-muted-foreground'}
        label="Backstory"
        action={backstory.connected ? null : <Link href="/connect" className={LINK}>Connect<span className="sr-only"> Backstory</span></Link>}
      >
        <p className="font-medium">{backstory.connected ? 'Connected' : 'Not connected'}</p>
        <p className="text-xs text-muted-foreground">
          {backstory.connected ? 'The analyst adds account context from Backstory.' : "The analysis runs on the account's data alone."}
        </p>
      </SetupRow>
    </ul>
  )
}

function SetupRow({ icon: Icon, iconClassName = 'text-horizon-600', label, action, children }: {
  icon: LucideIcon
  iconClassName?: string
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2.5">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconClassName)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        {children}
      </div>
      {action && <div className="shrink-0 pt-0.5">{action}</div>}
    </li>
  )
}
