/**
 * Code execution for agents — the `backstory://code` native plane.
 *
 * Without it an agent handed a CSV could read the text but not compute over
 * it, so "average deal size per rep per month" ended in an honest refusal or,
 * worse, numbers estimated by eye. `run_code` runs the agent's Python or
 * JavaScript in the same WASM sandbox as the Flows Code step
 * (src/features/flows/code-runner.ts): no network, no filesystem, no imports,
 * a hard deadline. Repository documents are loaded host-side and handed in as
 * data, with CSV/TSV files already parsed into rows.
 *
 * Read-only by construction — the code can only return a value.
 */

import { prisma } from '@/lib/prisma'
import { runFlowCode, type CodeLanguage, type CodeDataset, DATASET_TIMEOUT_MAX_MS } from '@/features/flows/code-runner'
import { repositoryScopeWhere } from '@/lib/knowledge/tools'
import { readStoredFile } from '@/lib/files/storage'
import { isTabular, parseDelimited } from './csv'
import { datasetFrameName } from './frame-name'

export { datasetFrameName }

export const RUN_CODE_TIMEOUT_MS = 20_000
export const RUN_CODE_MAX_DOCUMENTS = 8

export const CODE_TOOLS = [
  {
    name: 'run_code',
    description:
      'Run Python (default) or JavaScript in a sandbox to compute over data — aggregations, averages, group-bys, trends, rankings, chart series. Use it whenever an answer needs arithmetic over more than a handful of values: never estimate numbers you can compute. ' +
      'Pass repository documentIds (from repository_list / repository_search) to load files; the code receives `input` = {"files": [{"filename", "columns", "rows", "text"}], "frames": {name: DataFrame}, "data": <your data arg>}. ' +
      'Datasets (repository entries of kind "dataset" — large CSV/TSV files) arrive as pandas DataFrames in `input["frames"]`, keyed by the name repository_list shows, with `pd` and `np` available and the whole file loaded — use pandas group-bys, merges and cuts, and return aggregates, never rows. `records(df)` turns a frame into JSON rows; NaN, numpy scalars and timestamps in what you return are converted for you. Dataset runs may take a few minutes. ' +
      'Small CSV/TSV files arrive parsed in `files`: `rows` is a list of dicts keyed by header, every value a string. ' +
      'Write a function BODY that ends with `return <JSON-serializable value>`; print()/console.log output comes back as logs. No import statements (pandas is pre-loaded as pd), no network or files. Python extras: mean, median, stdev, Counter, defaultdict, to_number("$1,200") -> 1200.0, parse_date(s) -> datetime or None, month_key(s) -> "YYYY-MM".',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Function body. Must `return` the result, e.g. `return {"avg": mean([to_number(r["amount"]) for r in input["files"][0]["rows"]])}`.' },
        language: { type: 'string', enum: ['python', 'javascript'], description: 'Defaults to python.' },
        documentIds: { type: 'array', items: { type: 'string' }, description: `Repository document ids to load as input.files, up to ${RUN_CODE_MAX_DOCUMENTS}.` },
        data: { description: 'Optional inline JSON data (e.g. records from another tool) passed as input.data.' },
      },
      required: ['code'],
    },
  },
] satisfies ReadonlyArray<{
  name: string
  description: string
  isWrite: false
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}>

export type LoadedDocument = {
  id: string
  filename: string
  content: string | null
  truncated: boolean
  assetType?: string
  storedFileId?: string | null
}
export type DocumentLoader = (ids: string[]) => Promise<LoadedDocument[]>
export type DatasetBytesLoader = (storedFileId: string) => Promise<Buffer | null>


export class CodeAnalysisToolClient {
  private readonly loadDocuments: DocumentLoader
  private readonly loadDatasetBytes: DatasetBytesLoader

  constructor(
    organizationId: string,
    userId: string,
    agentId: string | null = null,
    loadDocuments?: DocumentLoader,
    loadDatasetBytes?: DatasetBytesLoader,
  ) {
    this.loadDocuments = loadDocuments ?? ((ids) => prisma.knowledgeDocument.findMany({
      where: {
        id: { in: ids },
        organizationId,
        isEnabled: true,
        status: 'ready',
        ...repositoryScopeWhere(organizationId, userId, agentId),
      },
      select: { id: true, filename: true, content: true, truncated: true, assetType: true, storedFileId: true },
    }))
    this.loadDatasetBytes = loadDatasetBytes ?? (async (storedFileId) => (await readStoredFile(storedFileId, organizationId))?.buffer ?? null)
  }

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'run_code') throw new Error(`Unknown code tool "${name}".`)
    const code = typeof args.code === 'string' ? args.code : ''
    if (!code.trim()) return { error: 'Pass the code to run in `code`.' }
    const language: CodeLanguage = args.language === 'javascript' ? 'javascript' : 'python'

    const ids = Array.isArray(args.documentIds)
      ? [...new Set(args.documentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
      : []
    if (ids.length > RUN_CODE_MAX_DOCUMENTS) {
      return { error: `Load at most ${RUN_CODE_MAX_DOCUMENTS} documents per run_code call.` }
    }
    const found = ids.length ? await this.loadDocuments(ids) : []
    const missing = ids.filter((id) => !found.some((doc) => doc.id === id))
    if (missing.length) {
      return { error: `No readable document with id ${missing.join(', ')} is available to you. Call repository_list to find the right id.` }
    }

    const warnings: string[] = []
    type InputFile = { documentId: string; filename: string; text: string; columns?: string[]; rows?: Record<string, string>[] }
    const datasetDocs = found.filter((doc) => doc.assetType === 'dataset' && doc.storedFileId)
    if (datasetDocs.length && language !== 'python') {
      return { error: 'Datasets are available to Python code only — drop the language argument.' }
    }
    const datasets: CodeDataset[] = []
    for (const doc of datasetDocs) {
      const bytes = await this.loadDatasetBytes(doc.storedFileId!)
      if (!bytes) return { error: `The dataset "${doc.filename}" could not be read from storage.` }
      datasets.push({ name: datasetFrameName(doc.filename), filename: doc.filename, bytes })
    }
    const files = ids.filter((id) => !datasetDocs.some((doc) => doc.id === id)).map((id): InputFile => {
      const doc = found.find((d) => d.id === id)!
      const text = doc.content ?? ''
      if (doc.truncated) {
        warnings.push(`"${doc.filename}" was truncated when it was added to the repository, so it holds only the first part of the original file — say so wherever you report totals or averages from it.`)
      }
      if (!isTabular(doc.filename)) return { documentId: doc.id, filename: doc.filename, text }
      const { columns, rows } = parseDelimited(text, doc.filename)
      return { documentId: doc.id, filename: doc.filename, columns, rows, text }
    })

    try {
      const { output, logs } = await runFlowCode({
        language,
        mode: 'all',
        analysis: true,
        code,
        input: { files, data: args.data ?? null },
        timeoutMs: datasets.length ? DATASET_TIMEOUT_MAX_MS : RUN_CODE_TIMEOUT_MS,
        ...(datasets.length ? { datasets } : {}),
      })
      return {
        output,
        logs,
        files: files.map((file) => ({
          filename: file.filename,
          ...(file.rows ? { rows: file.rows.length, columns: file.columns } : { chars: file.text.length }),
        })),
        ...(datasets.length ? { frames: datasets.map((dataset) => ({ name: dataset.name, filename: dataset.filename, bytes: dataset.bytes.length })) } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
    } catch (error) {
      // A code error is the agent's to fix and retry, not a run failure.
      return { error: error instanceof Error ? error.message : String(error), hint: 'Fix the code and call run_code again.' }
    }
  }
}
