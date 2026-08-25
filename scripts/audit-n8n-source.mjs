#!/usr/bin/env node

/**
 * Build a reproducible, source-derived inventory of the n8n checkout used by
 * the parity audit. This intentionally reads n8n's package manifests instead
 * of counting *.node.ts files: the manifests are the product's declared load
 * surface, while source directories also contain old versions and helpers.
 *
 * Usage:
 *   node scripts/audit-n8n-source.mjs /path/to/n8n [output.json]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const checkout = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(join(checkout, '.git'))) {
  console.error('Pass a checked-out n8n repository as the first argument.')
  process.exit(1)
}

const defaultOutput = resolve('docs/audits/n8n-source-inventory.json')
const output = resolve(process.argv[3] || defaultOutput)

function git(...args) {
  return execFileSync('git', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).trim()
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sourcePathFor(packageDir, declaredPath) {
  const candidate = join(packageDir, declaredPath.replace(/^dist\//, '').replace(/\.js$/, '.ts'))
  return {
    path: relative(checkout, candidate),
    exists: existsSync(candidate),
  }
}

function familyFor(declaredPath, kind) {
  const withoutPrefix = declaredPath.replace(/^dist\/(nodes|credentials)\//, '')
  if (kind === 'credential') return withoutPrefix.replace(/\.credentials\.js$/, '')
  const parts = withoutPrefix.split('/')
  return parts.length > 1 ? parts[0] : parts[0].replace(/\.node\.js$/, '')
}

function inferredKind(declaredPath) {
  const base = declaredPath.split('/').at(-1) || ''
  if (/Trigger\.node\.js$/.test(base)) return 'trigger'
  if (/Tool\.node\.js$/.test(base)) return 'tool'
  return 'action-or-utility'
}

const NATIVE_APPROXIMATION = new Map([
  ['ManualTrigger', 'manual trigger'],
  ['Schedule', 'schedule trigger'],
  ['Cron', 'schedule trigger'],
  ['Interval', 'schedule trigger'],
  ['Webhook', 'webhook trigger'],
  ['ErrorTrigger', 'flow.failed signal'],
  ['WorkflowTrigger', 'flow signal'],
  ['ExecuteWorkflow', 'subflow step'],
  ['HttpRequest', 'HTTP step'],
  ['GraphQL', 'HTTP GraphQL body mode'],
  ['If', 'condition step'],
  ['Switch', 'switch step'],
  ['Filter', 'filter step'],
  ['Set', 'transform step'],
  ['Code', 'sandboxed code step'],
  ['Function', 'sandboxed code step'],
  ['FunctionItem', 'per-item code step'],
  ['Merge', 'join step'],
  ['Wait', 'wait step'],
  ['StopAndError', 'stop step'],
  ['RespondToWebhook', 'output/webhook response behavior'],
  ['StickyNote', 'note node'],
  ['NoOp', 'disabled/pass-through or code step'],
  ['DateTime', 'date data operations'],
  ['Markdown', 'Markdown/HTML data operations'],
  ['Xml', 'XML data operations'],
  ['RenameKeys', 'rename-keys data operation'],
  ['Transform', 'data operations'],
  ['ItemLists', 'data operations and per-item execution'],
  ['SplitInBatches', 'loop/per-item execution'],
  ['AiTransform', 'AI transform step'],
  ['OpenAi', 'AI step and agent model execution'],
  ['MessageAnAgent', 'agent step'],
  ['Files', 'stored-file references and file parsing'],
  ['ReadBinaryFile', 'stored-file references'],
  ['ReadBinaryFiles', 'stored-file references'],
  ['WriteBinaryFile', 'stored-file output'],
  ['ReadPdf', 'PDF text extraction'],
  ['MoveBinaryData', 'file/text conversion'],
  ['SpreadsheetFile', 'CSV operations; spreadsheet formats are incomplete'],
])

const FIRST_CLASS_GAPS = new Map([
  ['DataTable', 'no permanent workflow data-table product or node'],
  ['Form', 'no hosted form/form-trigger surface'],
  ['SseTrigger', 'no SSE trigger'],
  ['DynamicCredentialCheck', 'no per-user dynamic credential resolver'],
  ['CompareDatasets', 'no compare-datasets node'],
  ['Compression', 'no archive/compression node'],
  ['Crypto', 'no crypto utility node'],
  ['Jwt', 'no JWT utility node'],
  ['Totp', 'no TOTP utility node'],
  ['ExecuteCommand', 'no host command node (intentional security boundary)'],
  ['LocalFileTrigger', 'no local filesystem trigger (intentional hosted boundary)'],
  ['Ssh', 'no SSH node'],
  ['Ftp', 'no FTP/SFTP node'],
  ['Evaluation', 'no productized workflow evaluation nodes'],
  ['DebugHelper', 'no equivalent debug-data generator node'],
  ['ExecutionData', 'no custom execution-metadata node'],
  ['Simulate', 'no simulation trigger/node pair'],
  ['TimeSaved', 'no time-saved node'],
])

const PARTIAL_PROVIDER_PATTERNS = [
  /\/Airtable\//,
  /\/Asana\//,
  /\/Confluence\//,
  /\/Figma\//,
  /\/Github\//,
  /\/Hubspot\//,
  /\/Jira\//,
  /\/Linear\//,
  /\/MondayCom\//,
  /\/Notion\//,
  /\/Salesforce\//,
  /\/Slack\//,
  /\/Zendesk\//,
  /\/Google\/(?:Drive|Gmail|Sheet)\//,
]

const PARTIAL_CREDENTIAL_PATTERN =
  /(?:Airtable|Asana|Confluence|Figma|Github|Hubspot|Jira|Linear|Monday|Notion|Salesforce|Slack|Zendesk|GoogleDrive|GoogleSheets|Gmail)/i

function nodeAssessment(entry) {
  if (entry.package === '@n8n/n8n-nodes-langchain') {
    return {
      coverage: 'partial-ai-stack',
      mechanism: 'agent, AI, knowledge, memory, MCP, and model features',
      note: 'The cluster is not node-for-node compatible; provider, vector-store, parser, retriever, and sub-node settings vary.',
    }
  }
  for (const [family, note] of FIRST_CLASS_GAPS) {
    if (entry.family === family) return { coverage: 'gap', mechanism: '', note }
  }
  for (const [family, mechanism] of NATIVE_APPROXIMATION) {
    if (entry.family === family) {
      return {
        coverage: 'partial-native',
        mechanism,
        note: 'A native Backstory capability exists, but this audit does not treat the n8n node version and all parameters as identical.',
      }
    }
  }
  if (PARTIAL_PROVIDER_PATTERNS.some((pattern) => pattern.test(entry.declaredPath))) {
    return {
      coverage: 'partial-provider',
      mechanism: 'curated Nango tool(s), activity/poll trigger, or generic HTTP/MCP',
      note: 'Provider reach exists, but n8n operation, trigger, credential, and parameter breadth is not reproduced.',
    }
  }
  if (entry.inferredKind === 'trigger') {
    return {
      coverage: 'gap-first-class-trigger',
      mechanism: 'webhook, activity, or poll may be manually configured',
      note: 'There is no provider-specific trigger with n8n-equivalent event and credential configuration.',
    }
  }
  return {
    coverage: 'generic-fallback-only',
    mechanism: 'generic HTTP or user-supplied MCP server when the service exposes one',
    note: 'No first-class node, operation catalogue, credential schema, dynamic options, or provider-specific UX.',
  }
}

function credentialAssessment(entry) {
  if (PARTIAL_CREDENTIAL_PATTERN.test(entry.declaredPath)) {
    return {
      coverage: 'partial-provider',
      note: 'Backstory can connect this provider through Nango or an integration secret, but does not reproduce this n8n credential schema.',
    }
  }
  return {
    coverage: 'no-schema-parity',
    note: 'Generic HTTP/MCP auth may reach the service, but this credential type and its fields/test behavior are not implemented as a first-class schema.',
  }
}

function declaredEntries(packagePath, packageLabel) {
  const packageDir = dirname(packagePath)
  const manifest = readJson(packagePath)
  const nodes = (manifest.n8n?.nodes || []).map((declaredPath) => ({
    package: packageLabel,
    declaredPath,
    family: familyFor(declaredPath, 'node'),
    inferredKind: inferredKind(declaredPath),
    source: sourcePathFor(packageDir, declaredPath),
  }))
  const credentials = (manifest.n8n?.credentials || []).map((declaredPath) => ({
    package: packageLabel,
    declaredPath,
    family: familyFor(declaredPath, 'credential'),
    source: sourcePathFor(packageDir, declaredPath),
  }))
  return { nodes, credentials }
}

function walkFiles(root) {
  if (!existsSync(root)) return []
  const files = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files.sort()
}

function moduleInventory(path) {
  const absolute = join(checkout, path)
  const files = walkFiles(absolute)
  let lines = 0
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|vue|md)$/.test(file)) continue
    lines += readFileSync(file, 'utf8').split(/\r?\n/).length
  }
  return { path, files: files.length, lines }
}

function immediateDirectoryInventories(path) {
  const absolute = join(checkout, path)
  if (!existsSync(absolute)) return []
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('__') && !entry.name.startsWith('.'))
    .map((entry) => moduleInventory(join(path, entry.name)))
    .sort((a, b) => a.path.localeCompare(b.path))
}

const packages = [
  declaredEntries(join(checkout, 'packages/nodes-base/package.json'), 'n8n-nodes-base'),
  declaredEntries(join(checkout, 'packages/@n8n/nodes-langchain/package.json'), '@n8n/n8n-nodes-langchain'),
]
const nodes = packages.flatMap((entry) => entry.nodes).map((entry) => ({
  ...entry,
  backstoryAssessment: nodeAssessment(entry),
}))
const credentials = packages.flatMap((entry) => entry.credentials).map((entry) => ({
  ...entry,
  backstoryAssessment: credentialAssessment(entry),
}))

const modulePaths = [
  'packages/cli/src/modules/agents',
  'packages/@n8n/agents',
  'packages/cli/src/modules/instance-ai',
  'packages/@n8n/instance-ai',
  'packages/@n8n/computer-use',
  'packages/@n8n/local-gateway',
  'packages/@n8n/mcp-browser-extension',
  'packages/frontend/editor-ui/src/features/ai',
  'packages/@n8n/workflow-sdk',
  'packages/cli/src/modules/engine-v2',
  'packages/@n8n/engine',
  'packages/@n8n/nodes-langchain',
  'packages/cli/src/modules/data-table',
  'packages/cli/src/modules/chat-hub',
  'packages/@n8n/chat-hub',
  'packages/cli/src/modules/dynamic-credentials.ee',
  'packages/cli/src/modules/oauth-server',
  'packages/cli/src/modules/breaking-changes',
  'packages/cli/src/modules/mcp',
  'packages/cli/src/modules/otel',
  'packages/cli/src/modules/source-control.ee',
  'packages/cli/src/modules/external-secrets.ee',
  'packages/cli/src/modules/log-streaming.ee',
  'packages/cli/src/modules/community-packages',
  'packages/cli/src/modules/type-availability-policies',
]

const familyCounts = Object.entries(
  nodes.reduce((counts, node) => {
    const key = `${node.package}:${node.family}`
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {}),
)
  .map(([family, count]) => ({ family, count }))
  .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))

const result = {
  schema: 'backstory-n8n-source-inventory@1',
  generatedAt: new Date().toISOString(),
  checkout: {
    repository: 'https://github.com/n8n-io/n8n.git',
    commit: git('rev-parse', 'HEAD'),
    committedAt: git('show', '-s', '--format=%cI', 'HEAD'),
    subject: git('show', '-s', '--format=%s', 'HEAD'),
    trackedFiles: Number(git('ls-files').split('\n').filter(Boolean).length),
  },
  declaredSurface: {
    nodeCount: nodes.length,
    credentialCount: credentials.length,
    missingNodeSources: nodes.filter((entry) => !entry.source.exists).length,
    missingCredentialSources: credentials.filter((entry) => !entry.source.exists).length,
    nodes,
    credentials,
    familyCounts,
  },
  modules: modulePaths.map(moduleInventory),
  cliModules: immediateDirectoryInventories('packages/cli/src/modules'),
  frontendFeatures: immediateDirectoryInventories('packages/frontend/editor-ui/src/features'),
}

writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(`Wrote ${output}`)
console.log(`n8n ${result.checkout.commit}: ${nodes.length} declared nodes, ${credentials.length} declared credentials`)
