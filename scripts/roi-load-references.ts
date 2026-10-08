/**
 * Load the ROI Analyst's reference files — the method and design guides, the
 * warehouse queries and the hand-built readouts and dashboards — as the
 * analyst's own knowledge documents, so the agent behind the ROI page can
 * read them. Run where the database and object storage are configured (the
 * worker), with an admin's user id:
 *
 *   npx tsx scripts/roi-load-references.ts --org <organizationId> [--user <adminUserId>] [--replace] <file ...>
 *
 * Text files (.md, .txt, .sql, the bare *_Query / *_SQL files) are stored as
 * text; HTML readouts and dashboards go through the file ingester, which
 * extracts their text. CSV extracts are not references — load those with
 * scripts/roi-load-extracts.ts. A file already loaded (same name) is skipped
 * unless --replace is passed, which disables the old copy and loads the new.
 */
import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '@/lib/prisma'
import { ingestKnowledgeFile, ingestKnowledgeText } from '@/lib/knowledge/ingest'
import { ensureRoiAgent, findRoiAgent } from '@/lib/roi/agent'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const TEXT_TYPES: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.sql': 'text/plain', '.json': 'application/json' }

/** What the file is, for the description the agent reads before opening it. */
function describe(filename: string): string {
  const lower = filename.toLowerCase()
  if (/query|sql/.test(lower)) return 'Warehouse query that produces one of the ROI extracts (Databricks SQL).'
  if (lower.endsWith('.html')) return 'A hand-built ROI readout or dashboard: reference output for the standard report.'
  if (lower === 'skill.md') return 'The visualisation method the first ROI dashboards were built with: chart choice, labels, colour, accuracy.'
  if (lower === 'build_dashboard.md') return 'The dashboard build guide the first ROI dashboards followed: layout, KPI cards, charts, filters, tables, performance.'
  if (lower === 'what_worked_well.md') return 'Retrospective of the first ROI dashboard project: method, design and build lessons.'
  if (lower.includes('brand')) return 'Backstory brand guidelines: voice, typography, colour and data-visualisation tokens.'
  return 'ROI analysis reference file.'
}

async function main() {
  const organizationId = arg('org')
  if (!organizationId) throw new Error('--org is required')
  const replace = process.argv.includes('--replace')
  const files: string[] = []
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index]
    if (value === '--org' || value === '--user') { index += 1; continue }
    if (value.startsWith('--')) continue
    files.push(value)
  }
  if (!files.length) throw new Error('Pass the files to load')
  const existingAgent = await findRoiAgent(organizationId)
  const userId = arg('user') ?? existingAgent?.userId
  if (!userId) throw new Error('--user is required when the workspace has no ROI Analyst yet')
  const agent = existingAgent ?? await ensureRoiAgent(organizationId, userId)
  const loaded = await prisma.knowledgeDocument.findMany({ where: { organizationId, agentId: agent.id }, select: { id: true, filename: true, isEnabled: true } })
  for (const file of files) {
    const filename = path.basename(file)
    if (/\.(csv|tsv)$/i.test(filename)) { console.log(`${filename}: an extract, not a reference — load it with scripts/roi-load-extracts.ts`); continue }
    const previous = loaded.filter((doc) => doc.filename === filename && doc.isEnabled)
    if (previous.length && !replace) { console.log(`${filename}: already loaded (${previous[0].id}); pass --replace to load it again`); continue }
    const buffer = fs.readFileSync(file)
    const ext = path.extname(filename).toLowerCase()
    const mimeType = TEXT_TYPES[ext] ?? (ext === '.html' ? 'text/html' : ext ? 'application/octet-stream' : 'text/plain')
    const started = Date.now()
    const document = ext === '.html'
      ? await ingestKnowledgeFile({ organizationId, agentId: agent.id, userId, filename, mimeType, buffer, description: describe(filename) })
      : await ingestKnowledgeText({ organizationId, agentId: agent.id, userId, filename: ext ? filename : `${filename}.sql`, mimeType, content: buffer.toString('utf8'), description: describe(filename) })
    if (previous.length) await prisma.knowledgeDocument.updateMany({ where: { id: { in: previous.map((doc) => doc.id) }, organizationId }, data: { isEnabled: false } })
    console.log(`${filename} → ${document.id} (${(buffer.length / 1e3).toFixed(0)} KB, ${Date.now() - started} ms)${previous.length ? ' · replaced' : ''}`)
  }
  console.log(`Loaded for the ROI Analyst (${agent.id}); its Knowledge list shows them.`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1) })
