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
  /** The version of the VIEWER's page this run produced, to open it in place (null when it is not on their page). */
  pageVersionId: string | null
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
  /** The account's generic report: the shared starting point, built from its data. */
  report: {
    artifactId: string
    /** Its current version (null while its first build runs). */
    versionId: string | null
    ready: boolean
    config: RoiRunConfig
    reason: string
    /** Built on current data: a settings change only rewrites the findings. */
    factsCurrent: boolean
    /** Imported from a value readout rather than built from extracts. */
    source?: 'readout'
    updatedAt: string
  } | null
  /** This person's own page for the account: its latest version there (null until they open it). */
  mine: {
    versionId: string
    config: RoiRunConfig
    reason: string
    factsCurrent: boolean
    updatedAt: string
    /** Where its data came from: a value readout, or a live read alone (no report then). */
    source?: 'readout' | 'live'
    /** Drawn with an older layout; opening it re-draws it. */
    stale?: boolean
  } | null
  /** The account's report has newer data than this person's page shows. */
  newerData: boolean
  /** A run updating this account for this person: their own change, or a build of the account's report. */
  activeAnalysisId: string | null
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
  /** This person's own ROI page (null until they first open an account). */
  page: { artifactId: string; currentAccount: string | null } | null
  /** The account everyone starts on once it has a report: Backstory's own readout. */
  defaultAccount: string | null
  /** May load an account's extracts from the panel (platform operators). */
  canLoadExtracts: boolean
  /** Accounts kept off the page (the analyst's owner chooses). */
  hiddenAccounts: string[]
  /** Hidden accounts the page would otherwise list, for the owner to bring back. */
  hiddenAvailable: string[]
}

/** Opening an account on this person's page. */
export type RoiOpenResult =
  | { status: 'ready'; artifactId: string; versionId: string }
  /** The account has no report to start from: it must be built first. */
  | { status: 'needs_build'; artifactId: string | null }
