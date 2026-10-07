import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { addVersion } from '@/lib/artifacts/service'
import { renderRoiDashboard } from './dashboard'
import { currentRoiState, readAccount360Facts, readFacts, readRoiState, stateJson, type RoiArtifactState } from './artifact-state'
import { readRunConfig, type RoiRunConfig } from './config'
import { ensureRoiAgent } from './agent'
import { EMPTY_VIEW } from './view'

/**
 * Everyone's own ROI page.
 *
 * Each person has one ROI page (an artifact they own). It starts from the
 * generic report of whichever account they open — the account's shared
 * report, built from its data — re-drawn with their own template (hidden
 * tabs, renamed or added metrics). Every change they make after that, from the
 * ROI page or its assistant, is the next version of THEIR page: settings,
 * edits, another account looked up. Nothing they do creates an artifact unless
 * they ask for one.
 *
 * A page's versions each carry the account they show (state.roi.account).
 * Opening an account moves the page's current version to that account's
 * latest one, so the assistant's edits always apply to what is on screen.
 *
 * The page is registered on the user (metadata.roiPageId): no schema change,
 * and one page per person in their workspace.
 */

const lower = (value: string) => value.trim().toLowerCase()

type UserMetadata = Record<string, unknown> & { roiPageId?: unknown }

function metadataOf(value: unknown): UserMetadata {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UserMetadata) : {}
}

/** The user's page, if they have one that still exists. */
export async function findPersonalPageId(organizationId: string, userId: string): Promise<string | null> {
  const user = await prisma.user.findFirst({ where: { id: userId, organizationId }, select: { metadata: true } })
  const id = metadataOf(user?.metadata).roiPageId
  if (typeof id !== 'string' || !id) return null
  const artifact = await prisma.artifact.findFirst({ where: { id, organizationId, userId, kind: 'roi_dashboard', archivedAt: null }, select: { id: true } })
  return artifact?.id ?? null
}

/** Every person's page in the workspace — never an account's generic report. */
export async function personalPageIds(organizationId: string): Promise<Set<string>> {
  const users = await prisma.user.findMany({ where: { organizationId }, select: { metadata: true } })
  return new Set(users.map((user) => metadataOf(user.metadata).roiPageId).filter((id): id is string => typeof id === 'string' && Boolean(id)))
}

/** The user's page, created (empty) and registered on first use. */
export async function ensurePersonalPage(organizationId: string, userId: string): Promise<string> {
  const existing = await findPersonalPageId(organizationId, userId)
  if (existing) return existing
  const user = await prisma.user.findFirst({ where: { id: userId, organizationId }, select: { name: true, email: true, metadata: true } })
  const agent = await ensureRoiAgent(organizationId, userId)
  const name = user?.name?.trim() || user?.email?.split('@')[0] || 'my'
  const artifact = await prisma.artifact.create({
    data: {
      organizationId,
      userId,
      kind: 'roi_dashboard',
      title: `ROI analysis · ${name}`,
      agentTaskId: agent.id,
      // Their page: the workspace can look, only they (and admins) change it.
      workspaceAccess: 'view',
    },
  })
  await prisma.user.update({
    where: { id: userId, organizationId },
    data: { metadata: { ...metadataOf(user?.metadata), roiPageId: artifact.id } as Prisma.InputJsonValue },
  })
  return artifact.id
}

export type PersonalAccountVersion = {
  versionId: string
  number: number
  createdAt: string
  config: RoiRunConfig
  reason: string
  factsCurrent: boolean
  /** The generic report version it started from, to tell when newer data exists. */
  basedOnVersionId: string | null
}

export type PersonalPage = {
  artifactId: string
  currentVersionId: string | null
  /** The account the page shows now. */
  currentAccount: string | null
  /** Its latest version for each account it has shown (keys lower-cased). */
  accounts: Record<string, PersonalAccountVersion & { account: string }>
}

/** The user's page and what it holds, account by account. */
export async function loadPersonalPage(organizationId: string, userId: string): Promise<PersonalPage | null> {
  const artifactId = await findPersonalPageId(organizationId, userId)
  if (!artifactId) return null
  const [artifact, versions] = await Promise.all([
    prisma.artifact.findFirst({ where: { id: artifactId, organizationId }, select: { currentVersionId: true } }),
    prisma.artifactVersion.findMany({ where: { artifactId, organizationId }, orderBy: { number: 'desc' }, take: 300, select: { id: true, number: true, createdAt: true, state: true } }),
  ])
  const accounts: PersonalPage['accounts'] = {}
  let currentAccount: string | null = null
  for (const version of versions) {
    const state = readRoiState(version.state)
    if (!state?.account) continue
    if (version.id === artifact?.currentVersionId) currentAccount = state.account
    const key = lower(state.account)
    if (accounts[key]) continue
    accounts[key] = {
      account: state.account,
      versionId: version.id,
      number: version.number,
      createdAt: version.createdAt.toISOString(),
      config: readRunConfig(state.config ?? {}),
      reason: state.reason ?? '',
      factsCurrent: state.factsVersion === 2,
      basedOnVersionId: state.basedOn?.versionId ?? null,
    }
  }
  return { artifactId, currentVersionId: artifact?.currentVersionId ?? null, currentAccount, accounts }
}

/** Show this version (point the page at it) without rewriting history. */
export async function setCurrentVersion(organizationId: string, artifactId: string, versionId: string): Promise<void> {
  const version = await prisma.artifactVersion.findFirst({ where: { id: versionId, artifactId, organizationId }, select: { id: true } })
  if (!version) throw new Error('That version is not on this page.')
  await prisma.artifact.update({ where: { id: artifactId, organizationId }, data: { currentVersionId: versionId } })
}

/** The template a page draws with: its latest view (hidden tabs, renamed and added metrics). */
async function templateViewOf(organizationId: string, artifactId: string) {
  const current = await currentRoiState(organizationId, artifactId).catch(() => null)
  return current?.state.view ?? null
}

/**
 * Put an account's generic report on the user's page, in their template:
 * the next version of their page. Used when they open (or look up) an account
 * their page has not shown, when they take newer data, and when a build they
 * started finishes.
 */
export async function populateFromGeneric(params: {
  organizationId: string
  userId: string
  account: string
  genericArtifactId: string
  /** Settings and reason to carry instead of the generic report's (the page's own). */
  config?: RoiRunConfig
  reason?: string
  request?: string
  executionId?: string | null
}): Promise<{ artifactId: string; versionId: string }> {
  const generic = await currentRoiState(params.organizationId, params.genericArtifactId)
  if (!generic) throw new Error(`The ${params.account} report has nothing to start from yet.`)
  const pageId = await ensurePersonalPage(params.organizationId, params.userId)
  const facts = await readFacts(params.organizationId, generic.state.factsFileId)
  if (!facts) throw new Error(`The ${params.account} report's data could not be read. Refresh its data to rebuild it.`)
  const a360 = await readAccount360Facts(params.organizationId, generic.state.a360FactsFileId)
  const view = (await templateViewOf(params.organizationId, pageId)) ?? generic.state.view ?? EMPTY_VIEW
  const config = params.config ?? generic.state.config
  const reason = params.reason ?? generic.state.reason ?? ''
  const html = renderRoiDashboard(facts, generic.state.narrative, { account: generic.state.account, generatedAt: new Date().toISOString(), view, config, reason, a360 })
  const state: RoiArtifactState['roi'] = {
    ...generic.state,
    view,
    ...(config ? { config } : {}),
    reason,
    personal: true,
    basedOn: { artifactId: params.genericArtifactId, versionId: generic.versionId },
  }
  const version = await addVersion({
    artifactId: pageId,
    organizationId: params.organizationId,
    content: html,
    executionId: params.executionId ?? null,
    request: params.request ?? `${generic.state.account} · started from the account's report`,
    createdByUserId: params.userId,
    state: stateJson(state),
  })
  return { artifactId: pageId, versionId: version.id }
}

export type OpenResult =
  | { status: 'ready'; artifactId: string; versionId: string }
  /** No generic report to start from: the account's report must be built first. */
  | { status: 'needs_build'; artifactId: string | null }

/**
 * Open an account on the user's page: its latest version there when it has
 * one (made current), otherwise the account's generic report put on the page.
 * `update` takes the generic report's newer data even when the page has the
 * account already — with the report's settings and findings, which were
 * written for that data; the page keeps its own layout.
 */
export async function openAccountOnPage(params: {
  organizationId: string
  userId: string
  account: string
  update?: boolean
  findGeneric: (account: string) => Promise<{ artifactId: string; account: string; hasVersion: boolean } | null>
}): Promise<OpenResult> {
  const page = await loadPersonalPage(params.organizationId, params.userId)
  const mine = page?.accounts[lower(params.account)]
  if (page && mine && !params.update) {
    if (page.currentVersionId !== mine.versionId) await setCurrentVersion(params.organizationId, page.artifactId, mine.versionId)
    return { status: 'ready', artifactId: page.artifactId, versionId: mine.versionId }
  }
  const generic = await params.findGeneric(params.account)
  if (!generic?.hasVersion) return { status: 'needs_build', artifactId: page?.artifactId ?? null }
  const made = await populateFromGeneric({
    organizationId: params.organizationId,
    userId: params.userId,
    account: generic.account,
    genericArtifactId: generic.artifactId,
    request: mine ? `${generic.account} · newer data from the account's report` : undefined,
  })
  return { status: 'ready', ...made }
}
