'use client'

import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { AUTOMATION_ASSET_CONTRACT_MARKER } from '@/lib/templates/automation-assets'

export type ProposalCard = {
  id: string
  title: string
  rationale: string
  kind: string
  status: string
  // Preview payload (returned by /api/template-proposals): what the user is
  // about to provision, so accept is an informed 1-click, not a leap of faith.
  configuration?: Record<string, unknown> | null
  sourceEvidence?: Record<string, unknown> | null
}

export const KIND_LABEL: Record<string, string> = {
  agent_template: 'New agent',
  flow_template: 'New flow',
  process_improvement: 'Improve something you already run',
}

/** Longest a derived "what it does" line gets before it's cut at a sentence. */
const SUMMARY_MAX = 180

/**
 * The proposal's own operating instructions with the server-appended asset
 * contract stripped — that boilerplate is identical on every proposal and is
 * pure noise to a human deciding whether to accept.
 */
export function proposalInstructions(proposal: ProposalCard): string {
  const config = (proposal.configuration ?? {}) as Record<string, unknown>
  const raw = proposal.kind === 'process_improvement'
    ? (typeof config.notes === 'string' ? config.notes : '')
    : (typeof config.instructions === 'string' ? config.instructions : '')
  return raw.split(AUTOMATION_ASSET_CONTRACT_MARKER)[0].trim()
}

/**
 * One short plain-English line of what accepting would actually do, taken from
 * the head of the instructions. Generated instructions run to hundreds of words
 * of tool plans and edge cases; dense surfaces (the notification bell) need the
 * first sentence or two, not the specification.
 */
export function proposalSummary(proposal: ProposalCard): string {
  const text = proposalInstructions(proposal).replace(/\s+/g, ' ').trim()
  if (text.length <= SUMMARY_MAX) return text
  const head = text.slice(0, SUMMARY_MAX)
  // Prefer a clean sentence break, but only if it isn't so early that the line
  // loses its meaning; otherwise cut on a word boundary and ellipsize.
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '))
  if (stop > SUMMARY_MAX / 2) return head.slice(0, stop + 1)
  const space = head.lastIndexOf(' ')
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`
}

/** The integration slugs a proposal will wire up (empty when none declared). */
export function proposalIntegrations(proposal: ProposalCard): string[] {
  const config = (proposal.configuration ?? {}) as Record<string, unknown>
  return Array.isArray(config.integrations)
    ? (config.integrations as unknown[]).filter((i): i is string => typeof i === 'string')
    : []
}

/**
 * Brand-logo chips for a proposal's integrations. `withLabel` shows the provider
 * name beside each logo (detail popup); logo-only stays compact for dense rows.
 */
export function IntegrationChips({ slugs, withLabel = false }: { slugs: string[]; withLabel?: boolean }) {
  if (!slugs.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1">
      {slugs.map((slug) =>
        withLabel ? (
          <span key={slug} className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
            <IntegrationLogo slug={slug} name={slug} className="h-3.5 w-3.5 rounded-[3px]" />
            {slug}
          </span>
        ) : (
          <IntegrationLogo key={slug} slug={slug} name={slug} className="h-4 w-4 rounded-[3px]" />
        ),
      )}
    </div>
  )
}

/**
 * Preview of what accepting will provision. `clamp` keeps it tight in inline
 * lists; the detail popup passes clamp={false}, which adds a collapsed section
 * for the full instructions — those are hundreds of words long, so they are
 * never rendered inline where they'd swamp the decision.
 */
export function ProposalPreview({ proposal, clamp = true }: { proposal: ProposalCard; clamp?: boolean }) {
  const config = (proposal.configuration ?? {}) as Record<string, unknown>
  const evidence = (proposal.sourceEvidence ?? {}) as Record<string, unknown>
  const integrations = proposalIntegrations(proposal)
  const summary = proposalSummary(proposal)
  const instructions = proposalInstructions(proposal)
  const schedule = typeof config.schedule === 'string' && config.schedule ? config.schedule : null
  const confidence = typeof evidence.confidence === 'number' ? Math.round(evidence.confidence * 100) : null
  const hasPreview = integrations.length || summary || schedule || confidence !== null
  if (!hasPreview) return null
  return (
    <div className="mt-2 space-y-1.5 border-t pt-2">
      {summary && <p className={clamp ? 'line-clamp-3 text-xs text-gray-600' : 'text-xs leading-5 text-gray-600'}>{summary}</p>}
      {!clamp && instructions.length > summary.length && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-indigo-600">Full instructions</summary>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap leading-5 text-gray-500">{instructions}</p>
        </details>
      )}
      <IntegrationChips slugs={integrations} withLabel />
      <div className="flex items-center gap-2 text-[10px] text-gray-400">
        {schedule && <span>Runs {schedule}</span>}
        {confidence !== null && <span>· {confidence}% confidence</span>}
      </div>
    </div>
  )
}
