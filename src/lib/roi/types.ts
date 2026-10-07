import type { RoiTimeframe } from './timeframe'
import type { RoiRunConfig } from './config'

/**
 * Wire types for the ROI pages. A leaf module on purpose: the client
 * components import these, and nothing here may reach the server data
 * layer (service.ts does, and is server-only).
 */

export type RoiChatMessage = {
  role: 'user' | 'agent'
  content: string
  executionId?: string
  status?: 'pending' | 'completed' | 'failed'
  createdAt: string
}

export type RoiDataset = { documentId: string; filename: string; frame: string; rows: number | null }

/**
 * Where a run is, in words the page can show. `fetching` is the data flow
 * (or the repository lookup that stands in for it); `computing` the prep;
 * `writing` the analyst's narrative; `building` the report render.
 */
export type RoiRunPhase = 'queued' | 'fetching' | 'computing' | 'writing' | 'building' | 'ready' | 'failed'

/** One headline number a run records, so runs of an account can be compared over time. */
export type RoiRunKpi = {
  key: string
  label: string
  value: number | null
  /** Formatted for display: "+12.4%", "2.1×", "$48K", "61.0%". */
  display: string
}

export type RoiAnalysisView = {
  id: string
  account: string
  template: string
  timeframe: RoiTimeframe
  timeframeLabel: string
  /** How the run was configured on the page (defaults for older analyses). */
  config: RoiRunConfig
  /** The configuration in words, one line per setting. */
  configSummary: string[]
  /** Why it was run (QBR, renewal…). Empty for analyses started before the page. */
  reason: string
  context: string
  status: string
  phase: RoiRunPhase
  /** full = data computed and findings written; reconfigure = findings rewritten for new settings on the report's data. */
  mode: 'full' | 'reconfigure'
  /** The report version the run produced (completed runs). */
  versionId: string | null
  error: string | null
  executionId: string | null
  agentTaskId: string | null
  artifactId: string | null
  hasReport: boolean
  results: unknown
  /** Headline numbers for run-over-run comparison (completed runs). */
  kpis: RoiRunKpi[]
  chat: RoiChatMessage[]
  datasets: RoiDataset[]
  /** Who started it, for run history. */
  requestedBy: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/** An account the page can show: it has a report, or data to build one (loaded extracts, or the data flow). */
export type RoiPageAccount = {
  account: string
  /** Extract kinds loaded, e.g. ["activity", "usage", "engagement", "stages", "clickstream"]. */
  extracts: string[]
  /** Labels of the report sections those extracts feed. */
  covers: string[]
  loadedAt: string | null
  /** The account's one report, when it has been built. Settings changes update it in place. */
  report: {
    artifactId: string
    config: RoiRunConfig
    reason: string
    /** Built on current data: a settings change only rewrites the findings. */
    factsCurrent: boolean
    updatedAt: string
    /** A run updating it right now. */
    activeAnalysisId: string | null
    /** It has a version to show (false while its first build runs). */
    ready: boolean
  } | null
  /** Data can be (re)computed: extracts are loaded or the data flow is connected. */
  canRefresh: boolean
}

/** What the page needs to draw its form: accounts, the agent behind it, where data comes from. */
export type RoiPageSetup = {
  accounts: RoiPageAccount[]
  /** The private admin agent that runs every analysis on this page. */
  agent: { id: string | null; title: string; model: string | null; canConfigure: boolean; ownerName: string | null }
  /** Where a run's data comes from: the loaded extracts today, a platform flow once one is connected. */
  dataSource: { kind: 'repository' | 'flow'; flowId: string | null; flowName: string | null }
  /** Flows an admin may pick as the data source (empty for everyone else). */
  flows: Array<{ id: string; name: string; published: boolean }>
  /** Whether the analyst can reach the Backstory platform (account context) for this user. */
  backstory: { connected: boolean }
  /** Typical time for a full build, in seconds — the page's progress estimate. */
  expectedSeconds: number
  /** Typical time for a settings change (findings rewritten on the same data). */
  reconfigureSeconds: number
  /** After this many seconds the page tells the user it will notify them instead. */
  asyncAfterSeconds: number
}
