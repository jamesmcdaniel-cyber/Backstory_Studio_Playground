/**
 * Load an account's ROI extracts into a workspace's repository, tagged so
 * /roi finds them by account. Run where the database and object storage
 * are configured (the worker):
 *
 *   npx tsx scripts/roi-load-extracts.ts --org <organizationId> --account "Iron Mountain" \
 *     --activity "Raw Data Extract.csv" --usage "Usage Cohort.csv" \
 *     --engagement OppEngagement.csv --stages "Closed Deals Opp Engagement Stage Analysis.csv" \
 *     [--user <userId>] [--run <userId>] [--trusted]
 *
 * --trusted skips the browser-upload malware scanner: use it only for files
 * you have inspected yourself (the worker has no scanner configured).
 * --run starts the first analysis for that user once the extracts are in,
 * so the page has a dashboard waiting instead of an empty form.
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadRoiSource, ROI_SOURCE_KINDS, type RoiSourceKind } from '@/lib/roi/sources'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const organizationId = arg('org')
  const account = arg('account')
  if (!organizationId || !account) throw new Error('--org and --account are required')
  const userId = arg('user') ?? null
  const files = ROI_SOURCE_KINDS.map((kind) => [kind, arg(kind)] as const).filter((entry): entry is readonly [RoiSourceKind, string] => Boolean(entry[1]))
  if (!files.length) throw new Error('Pass at least one of --activity, --usage, --engagement, --stages')
  for (const [kind, file] of files) {
    const buffer = fs.readFileSync(file)
    const started = Date.now()
    const loaded = await loadRoiSource({ organizationId, userId, account, kind, filename: path.basename(file), buffer, trusted: process.argv.includes('--trusted') })
    console.log(`${kind}: ${path.basename(file)} → ${loaded.documentId} (${loaded.rows?.toLocaleString() ?? '?'} rows, ${(buffer.length / 1e6).toFixed(1)} MB, ${Date.now() - started} ms)`)
  }
  const runAs = arg('run')
  if (runAs) {
    const { createRoiAnalysis } = await import('@/lib/roi/service')
    const row = await createRoiAnalysis({ organizationId, userId: runAs, account, timeframe: { preset: 'last6_vs_prior6' }, context: '' })
    console.log(`analysis ${row.id} ${row.status} (execution ${row.executionId ?? '—'})`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => { console.error(error); process.exit(1) })
