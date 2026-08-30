import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { findSecretCandidates } from '@/lib/catalogue/sanitize'
import { replaceKnowledgeDocumentContent, ingestKnowledgeText } from '@/lib/knowledge/ingest'
import { defaultProxy, resolveNangoConnection, type DeliveryConnection, type NangoProxy } from '@/lib/nango/delivery'
import { PROVIDER_CONFIG_KEYS } from '@/lib/nango/provider-tools'
import { prisma } from '@/lib/prisma'

export const GITHUB_SYNC_MAX_FILES = 50
export const GITHUB_SYNC_MAX_FILE_BYTES = 200_000
export const GITHUB_SYNC_MAX_TOTAL_BYTES = 5_000_000

const SOURCE_PROVIDER = 'nango:github'
const SOURCE_TOOL = 'github_repository_sync'

export class GitHubConnectionUnavailableError extends Error {}
export class GitHubSyncInputError extends Error {}
export class GitHubSyncUpstreamError extends Error {}

export type GitHubRepositoryOption = {
  id: number
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  updatedAt: string | null
  htmlUrl: string | null
}

type GitHubRepositoryResponse = {
  id?: unknown
  name?: unknown
  full_name?: unknown
  private?: unknown
  default_branch?: unknown
  updated_at?: unknown
  html_url?: unknown
  owner?: { login?: unknown }
}

type GitHubTreeEntry = {
  path: string
  type: 'blob' | 'tree'
  sha: string
  size?: number
}

type GitHubTreeResponse = {
  truncated: boolean
  tree: GitHubTreeEntry[]
}

type ExistingSyncedFile = {
  id: string
  sourceKey: string | null
  sourceMetadata: unknown
  version: number
  status: string
  isEnabled: boolean
}

export type GitHubSyncPlan = {
  selected: GitHubTreeEntry[]
  retainedPaths: Set<string>
  skipped: Record<string, number>
}

export type GitHubSyncResult = {
  repository: GitHubRepositoryOption
  ref: string
  pathPrefix: string
  created: number
  updated: number
  unchanged: number
  disabled: number
  failed: number
  skipped: Record<string, number>
}

const SUPPORTED_EXTENSIONS = new Set([
  '.adoc', '.bash', '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.dockerfile',
  '.fish', '.go', '.graphql', '.gql', '.h', '.hpp', '.htm', '.html', '.ini', '.java',
  '.js', '.json', '.jsonl', '.jsx', '.kt', '.kts', '.less', '.log', '.lua', '.md',
  '.mdx', '.mjs', '.mts', '.php', '.properties', '.proto', '.py', '.rb', '.rs', '.rst',
  '.sass', '.scss', '.sh', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.tsv',
  '.txt', '.vue', '.xml', '.yaml', '.yml', '.zsh',
])
const SUPPORTED_NAMES = new Set([
  'dockerfile', 'license', 'makefile', 'procfile', 'readme', 'security.md',
])
const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.output', '.parcel-cache', '.turbo', '.venv', 'bower_components',
  'build', 'coverage', 'dist', 'node_modules', 'obj', 'target', 'vendor',
])
const IGNORED_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', 'bun.lockb', 'composer.lock', 'package-lock.json',
  'pnpm-lock.yaml', 'poetry.lock', 'yarn.lock',
])
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))|\.(?:key|keystore|p12|pfx|pem)$/i

function count(into: Record<string, number>, reason: string): void {
  into[reason] = (into[reason] ?? 0) + 1
}

function extension(path: string): string {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

function supportedPath(path: string): { ok: true } | { ok: false; reason: string } {
  if (
    !path || path.length > 1_000 || path.startsWith('/') || path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path) || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) return { ok: false, reason: 'unsafe_path' }
  const segments = path.toLowerCase().split('/')
  const name = segments.at(-1) ?? ''
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return { ok: false, reason: 'generated_or_dependency_path' }
  if (SENSITIVE_PATH.test(path) || IGNORED_NAMES.has(name)) return { ok: false, reason: 'sensitive_path' }
  const ext = extension(path)
  if (!SUPPORTED_EXTENSIONS.has(ext) && !SUPPORTED_NAMES.has(name)) return { ok: false, reason: 'unsupported_type' }
  return { ok: true }
}

/** Pure, deterministic limits/policy pass used before any blob contents are fetched. */
export function planGitHubTree(entries: GitHubTreeEntry[], maxFiles = GITHUB_SYNC_MAX_FILES): GitHubSyncPlan {
  const skipped: Record<string, number> = {}
  const accepted: GitHubTreeEntry[] = []
  for (const entry of entries) {
    if (entry.type !== 'blob') continue
    const policy = supportedPath(entry.path)
    if (!policy.ok) {
      count(skipped, policy.reason)
      continue
    }
    if (!Number.isFinite(entry.size) || (entry.size ?? 0) <= 0) {
      count(skipped, 'empty_or_unknown_size')
      continue
    }
    if ((entry.size ?? 0) > GITHUB_SYNC_MAX_FILE_BYTES) {
      count(skipped, 'file_too_large')
      continue
    }
    accepted.push(entry)
  }
  accepted.sort((a, b) => a.path.localeCompare(b.path))

  const selected: GitHubTreeEntry[] = []
  let totalBytes = 0
  for (const entry of accepted) {
    if (selected.length >= Math.max(1, Math.min(maxFiles, GITHUB_SYNC_MAX_FILES))) {
      count(skipped, 'file_limit')
      continue
    }
    if (totalBytes + (entry.size ?? 0) > GITHUB_SYNC_MAX_TOTAL_BYTES) {
      count(skipped, 'total_size_limit')
      continue
    }
    selected.push(entry)
    totalBytes += entry.size ?? 0
  }
  return { selected, retainedPaths: new Set(accepted.map((entry) => entry.path)), skipped }
}

export function normalizeGitHubPathPrefix(raw: string | undefined): string {
  const normalized = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!normalized) return ''
  if (normalized.includes('\\') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new GitHubSyncInputError('GitHub path must be a repository-relative directory without dot segments.')
  }
  return normalized
}

export function normalizeGitHubRef(raw: string): string {
  const ref = raw.trim()
  if (
    !ref || ref.length > 255 || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') ||
    ref.includes('..') || ref.includes('@{') || ref.includes('//') ||
    /[\u0000-\u0020\u007f~^:?*[\]\\]/.test(ref)
  ) throw new GitHubSyncInputError('Use a valid GitHub branch, tag, or commit ref.')
  return ref
}

function parseRepository(value: GitHubRepositoryResponse): GitHubRepositoryOption | null {
  const id = Number(value.id)
  const owner = typeof value.owner?.login === 'string' ? value.owner.login : ''
  const name = typeof value.name === 'string' ? value.name : ''
  const fullName = `${owner}/${name}`
  const defaultBranch = typeof value.default_branch === 'string' ? value.default_branch : ''
  if (!Number.isSafeInteger(id) || !owner || !name || !fullName || !defaultBranch) return null
  return {
    id,
    fullName,
    owner,
    name,
    private: value.private === true,
    defaultBranch,
    updatedAt: typeof value.updated_at === 'string' ? value.updated_at : null,
    htmlUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  }
}

async function githubConnection(organizationId: string, userId: string): Promise<DeliveryConnection> {
  const connection = await resolveNangoConnection(organizationId, PROVIDER_CONFIG_KEYS.github, userId)
  if (!connection) throw new GitHubConnectionUnavailableError('Connect GitHub in Integrations before synchronizing a repository.')
  return connection
}

async function request(proxy: NangoProxy, connection: DeliveryConnection, endpoint: string, params?: Record<string, string | number>) {
  try {
    const response = await proxy({
      method: 'GET',
      endpoint,
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
      ...(params ? { params } : {}),
    })
    return response.data
  } catch {
    // Provider errors can echo request headers or OAuth details. Keep them out
    // of API responses, audit records, and failed repository artifacts.
    throw new GitHubSyncUpstreamError('GitHub could not complete the read request. Verify the connection and try again.')
  }
}

export async function listGitHubRepositories(params: {
  organizationId: string
  userId: string
  proxy?: NangoProxy
}): Promise<{ repositories: GitHubRepositoryOption[]; connectionScope: 'user' | 'org' }> {
  const connection = await githubConnection(params.organizationId, params.userId)
  const proxy = params.proxy ?? defaultProxy()
  const repositories: GitHubRepositoryOption[] = []
  for (let page = 1; page <= 3; page += 1) {
    const data = await request(proxy, connection, '/user/repos', { per_page: 100, page, sort: 'updated' })
    if (!Array.isArray(data)) throw new GitHubSyncUpstreamError('GitHub returned an invalid repository list.')
    repositories.push(...data.map((entry) => parseRepository(entry as GitHubRepositoryResponse)).filter((entry): entry is GitHubRepositoryOption => Boolean(entry)))
    if (data.length < 100) break
  }
  return {
    repositories: Array.from(new Map(repositories.map((repository) => [repository.id, repository])).values()),
    connectionScope: connection.scope,
  }
}

function treeResponse(value: unknown): GitHubTreeResponse {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tree?: unknown }).tree)) {
    throw new GitHubSyncUpstreamError('GitHub returned an invalid repository tree.')
  }
  const tree = (value as { tree: unknown[] }).tree.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    if (typeof row.path !== 'string' || typeof row.sha !== 'string' || (row.type !== 'blob' && row.type !== 'tree')) return []
    return [{ path: row.path, sha: row.sha, type: row.type, ...(typeof row.size === 'number' ? { size: row.size } : {}) } as GitHubTreeEntry]
  })
  return { truncated: (value as { truncated?: unknown }).truncated === true, tree }
}

async function repositoryTree(params: {
  proxy: NangoProxy
  connection: DeliveryConnection
  owner: string
  repo: string
  ref: string
  pathPrefix: string
}): Promise<GitHubTreeEntry[]> {
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/git/trees/`
  let treeish = params.ref
  if (params.pathPrefix) {
    for (const segment of params.pathPrefix.split('/')) {
      const level = treeResponse(await request(params.proxy, params.connection, `${base}${encodeURIComponent(treeish)}`))
      const next = level.tree.find((entry) => entry.type === 'tree' && entry.path === segment)
      if (!next) throw new GitHubSyncInputError(`GitHub directory "${params.pathPrefix}" was not found at ref "${params.ref}".`)
      treeish = next.sha
    }
  }
  const result = treeResponse(await request(params.proxy, params.connection, `${base}${encodeURIComponent(treeish)}`, { recursive: '1' }))
  if (result.truncated) {
    throw new GitHubSyncInputError('This GitHub tree is too large for a complete sync. Choose a smaller directory and try again.')
  }
  return result.tree.map((entry) => ({
    ...entry,
    path: params.pathPrefix ? `${params.pathPrefix}/${entry.path}` : entry.path,
  }))
}

function sourceMetadata(value: unknown): { path?: string; blobSha?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const github = (value as { github?: unknown }).github
  if (!github || typeof github !== 'object' || Array.isArray(github)) return {}
  return {
    path: typeof (github as { path?: unknown }).path === 'string' ? (github as { path: string }).path : undefined,
    blobSha: typeof (github as { blobSha?: unknown }).blobSha === 'string' ? (github as { blobSha: string }).blobSha : undefined,
  }
}

function stableKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

function repositoryFilename(fullName: string, path: string): string {
  const suffix = `${fullName}/${path}`
  if (suffix.length <= 200) return suffix
  const prefix = fullName.slice(0, 120)
  return `${prefix}/…${path.slice(-Math.max(1, 198 - prefix.length))}`
}

function mimeType(path: string): string {
  const ext = extension(path)
  if (ext === '.md' || ext === '.mdx') return 'text/markdown'
  if (ext === '.json' || ext === '.jsonl') return 'application/json'
  if (ext === '.html' || ext === '.htm') return 'text/html'
  if (ext === '.csv') return 'text/csv'
  return 'text/plain'
}

export function decodeGitHubBlob(value: unknown): string {
  if (!value || typeof value !== 'object') throw new GitHubSyncUpstreamError('GitHub returned an invalid file payload.')
  const row = value as Record<string, unknown>
  if (row.encoding !== 'base64' || typeof row.content !== 'string') throw new GitHubSyncUpstreamError('GitHub did not return a readable file payload.')
  const buffer = Buffer.from(row.content.replace(/\s/g, ''), 'base64')
  if (!buffer.length || buffer.length > GITHUB_SYNC_MAX_FILE_BYTES || buffer.includes(0)) {
    throw new GitHubSyncInputError('The file is empty, binary, or exceeds the per-file sync limit.')
  }
  const content = buffer.toString('utf8')
  const replacements = content.match(/\uFFFD/g)?.length ?? 0
  if (replacements > 3 && replacements / content.length > 0.001) {
    throw new GitHubSyncInputError('The file is not valid readable UTF-8 text.')
  }
  if (findSecretCandidates({ content }, 1).length > 0) {
    throw new GitHubSyncInputError('The file appears to contain a literal credential and was not indexed.')
  }
  return content
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await fn(values[index]!)
    }
  }))
  return results
}

async function persistFile(params: {
  organizationId: string
  userId: string
  agentId: string | null
  connection: DeliveryConnection
  repository: GitHubRepositoryOption
  ref: string
  entry: GitHubTreeEntry
  content: string
  sourceKey: string
  sourceGroupKey: string
  existing?: ExistingSyncedFile
  syncedAt: Date
}): Promise<'created' | 'updated'> {
  const metadata = {
    github: {
      owner: params.repository.owner,
      repo: params.repository.name,
      fullName: params.repository.fullName,
      path: params.entry.path,
      ref: params.ref,
      blobSha: params.entry.sha,
      private: params.repository.private,
      htmlUrl: params.repository.htmlUrl,
    },
    syncedAt: params.syncedAt.toISOString(),
  }
  const description = `Synced from GitHub ${params.repository.fullName}@${params.ref}:${params.entry.path}`
  const existing = params.existing ?? await prisma.knowledgeDocument.findFirst({
    where: { organizationId: params.organizationId, sourceKey: params.sourceKey },
    select: { id: true, sourceKey: true, sourceMetadata: true, version: true, status: true, isEnabled: true },
  })
  if (existing) {
    await replaceKnowledgeDocumentContent({
      organizationId: params.organizationId,
      documentId: existing.id,
      agentId: params.agentId,
      content: params.content,
      incrementVersion: true,
      expectedVersion: existing.version,
      metadata: {
        filename: repositoryFilename(params.repository.fullName, params.entry.path),
        description,
      },
    })
    await prisma.knowledgeDocument.updateMany({
      where: { id: existing.id, organizationId: params.organizationId, version: existing.version + 1 },
      data: {
        mimeType: mimeType(params.entry.path),
        sizeBytes: params.entry.size ?? Buffer.byteLength(params.content),
        sourceConnectionId: params.connection.connectionId,
        sourceProvider: SOURCE_PROVIDER,
        sourceTool: SOURCE_TOOL,
        sourceMetadata: metadata,
        lastSyncedAt: params.syncedAt,
      },
    })
    return 'updated'
  }

  try {
    await ingestKnowledgeText({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: params.agentId,
      filename: repositoryFilename(params.repository.fullName, params.entry.path),
      description,
      mimeType: mimeType(params.entry.path),
      content: params.content,
      sizeBytes: params.entry.size,
      assetType: 'synced_file',
      sourceType: 'integration',
      sourceProvider: SOURCE_PROVIDER,
      sourceConnectionId: params.connection.connectionId,
      sourceTool: SOURCE_TOOL,
      sourceKey: params.sourceKey,
      sourceGroupKey: params.sourceGroupKey,
      sourceMetadata: metadata,
      lastSyncedAt: params.syncedAt,
    })
    return 'created'
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const raced = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: params.organizationId, sourceKey: params.sourceKey },
      select: { id: true, sourceKey: true, sourceMetadata: true, version: true, status: true, isEnabled: true },
    })
    if (!raced) throw error
    return persistFile({ ...params, existing: raced })
  }
}

export async function syncGitHubRepository(params: {
  organizationId: string
  userId: string
  agentId: string | null
  workspaceScope: boolean
  owner: string
  repo: string
  ref?: string
  pathPrefix?: string
  maxFiles?: number
  proxy?: NangoProxy
}): Promise<GitHubSyncResult> {
  if ((params.agentId === null) !== params.workspaceScope) {
    throw new GitHubSyncInputError('Choose exactly one repository scope: a specific agent or the whole workspace.')
  }
  const pathPrefix = normalizeGitHubPathPrefix(params.pathPrefix)
  const connection = await githubConnection(params.organizationId, params.userId)
  const proxy = params.proxy ?? defaultProxy()
  const rawRepository = await request(
    proxy,
    connection,
    `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
  )
  const repository = parseRepository(rawRepository as GitHubRepositoryResponse)
  if (!repository || repository.owner.toLowerCase() !== params.owner.toLowerCase() || repository.name.toLowerCase() !== params.repo.toLowerCase()) {
    throw new GitHubSyncUpstreamError('GitHub returned invalid repository details.')
  }
  const ref = normalizeGitHubRef(params.ref?.trim() || repository.defaultBranch)
  const entries = await repositoryTree({ proxy, connection, owner: repository.owner, repo: repository.name, ref, pathPrefix })
  const plan = planGitHubTree(entries, params.maxFiles)
  const scopeKey = params.agentId ? `agent:${params.agentId}` : 'workspace'
  // OAuth connection ids can rotate on reconnect. Key the logical source to
  // its credential ownership plane so reconnecting updates the same files,
  // while a personal and an org-shared connection never collapse together.
  const connectionOwnerKey = connection.scope === 'user' ? `user:${params.userId}` : 'org'
  const sourceGroupKey = stableKey('github-sync-v1', connectionOwnerKey, repository.fullName.toLowerCase(), ref, scopeKey)
  const existing = await prisma.knowledgeDocument.findMany({
    where: { organizationId: params.organizationId, sourceGroupKey },
    select: { id: true, sourceKey: true, sourceMetadata: true, version: true, status: true, isEnabled: true },
  })
  const byKey = new Map(existing.flatMap((document) => document.sourceKey ? [[document.sourceKey, document] as const] : []))
  const syncedAt = new Date()
  let unchanged = 0
  const toFetch: Array<{ entry: GitHubTreeEntry; sourceKey: string; existing?: ExistingSyncedFile }> = []
  for (const entry of plan.selected) {
    const sourceKey = stableKey(sourceGroupKey, entry.path)
    const previous = byKey.get(sourceKey)
    if (previous && previous.status === 'ready' && sourceMetadata(previous.sourceMetadata).blobSha === entry.sha) {
      unchanged += 1
      await prisma.knowledgeDocument.updateMany({
        where: { id: previous.id, organizationId: params.organizationId },
        data: { lastSyncedAt: syncedAt, sourceConnectionId: connection.connectionId },
      })
    } else {
      toFetch.push({ entry, sourceKey, existing: previous })
    }
  }

  const blockedPaths = new Set<string>()
  let failed = 0
  const fetched = await mapConcurrent(toFetch, 6, async (item) => {
    try {
      const blob = await request(
        proxy,
        connection,
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/blobs/${encodeURIComponent(item.entry.sha)}`,
      )
      return { ...item, content: decodeGitHubBlob(blob) }
    } catch (error) {
      failed += 1
      if (error instanceof GitHubSyncInputError) blockedPaths.add(item.entry.path)
      return null
    }
  })

  let created = 0
  let updated = 0
  await mapConcurrent(fetched.filter((item): item is NonNullable<typeof item> => Boolean(item)), 3, async (item) => {
    try {
      const result = await persistFile({
        organizationId: params.organizationId,
        userId: params.userId,
        agentId: params.agentId,
        connection,
        repository,
        ref,
        entry: item.entry,
        content: item.content,
        sourceKey: item.sourceKey,
        sourceGroupKey,
        existing: item.existing,
        syncedAt,
      })
      if (result === 'created') created += 1
      else updated += 1
    } catch {
      failed += 1
    }
  })

  for (const path of blockedPaths) plan.retainedPaths.delete(path)
  const appliesToPrefix = (path: string) => !pathPrefix || path === pathPrefix || path.startsWith(`${pathPrefix}/`)
  const staleIds = existing.flatMap((document) => {
    const path = sourceMetadata(document.sourceMetadata).path
    return path && appliesToPrefix(path) && !plan.retainedPaths.has(path) ? [document.id] : []
  })
  const disabled = staleIds.length
    ? (await prisma.knowledgeDocument.updateMany({
        where: { id: { in: staleIds }, organizationId: params.organizationId, sourceGroupKey },
        data: { isEnabled: false, lastSyncedAt: syncedAt },
      })).count
    : 0

  if (blockedPaths.size) plan.skipped.secret_or_binary_content = blockedPaths.size
  return {
    repository,
    ref,
    pathPrefix,
    created,
    updated,
    unchanged,
    disabled,
    failed,
    skipped: plan.skipped,
  }
}
