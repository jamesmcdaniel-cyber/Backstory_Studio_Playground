import type { RoiTimeframe } from './timeframe'

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

export type RoiAnalysisView = {
  id: string
  account: string
  timeframe: RoiTimeframe
  timeframeLabel: string
  context: string
  status: string
  error: string | null
  executionId: string | null
  agentTaskId: string | null
  artifactId: string | null
  hasReport: boolean
  results: unknown
  chat: RoiChatMessage[]
  datasets: RoiDataset[]
  createdAt: string
  updatedAt: string
}
