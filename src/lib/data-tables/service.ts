import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { dataTableColumnsSchema, normalizeDataTableRow } from '@/lib/data-tables/schema'

export type DataTableRef = { tableId?: string; tableName?: string }

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

function refWhere(organizationId: string, ref: DataTableRef) {
  const tableId = ref.tableId?.trim()
  const tableName = ref.tableName?.trim()
  if (Boolean(tableId) === Boolean(tableName)) throw new Error('Pass exactly one of tableId or tableName.')
  return {
    organizationId,
    ...(tableId
      ? { id: tableId }
      : { name: { equals: tableName!, mode: 'insensitive' as const } }),
  }
}

export async function resolveDataTable(organizationId: string, ref: DataTableRef) {
  const table = await prisma.dataTable.findFirst({ where: refWhere(organizationId, ref) })
  if (!table) throw new Error('Data table not found.')
  return table
}

export async function listDataTables(organizationId: string) {
  return prisma.dataTable.findMany({
    where: { organizationId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, description: true, columns: true, version: true, createdAt: true, updatedAt: true },
  })
}

export async function listDataTableRows(
  organizationId: string,
  ref: DataTableRef,
  options: { where?: Record<string, unknown>; limit?: number; offset?: number } = {},
) {
  const table = await resolveDataTable(organizationId, ref)
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 100)))
  const offset = Math.max(0, Math.min(10_000, Math.round(options.offset ?? 0)))
  // Push the equality predicates into PostgreSQL before offset/limit. The old
  // bounded in-memory scan could report zero matches when sparse matches lived
  // after its first window — an especially dangerous shape for upsert, which
  // could then create a duplicate row.
  const predicates: Prisma.DataTableRowWhereInput[] = Object.entries(options.where ?? {}).map(
    ([key, value]) => ({
      data: {
        path: [key],
        equals: value === null ? Prisma.JsonNull : jsonValue(value),
      },
    }),
  )
  const rows = await prisma.dataTableRow.findMany({
    where: {
      organizationId,
      tableId: table.id,
      ...(predicates.length ? { AND: predicates } : {}),
    },
    orderBy: { createdAt: 'asc' },
    skip: offset,
    take: limit + 1,
    select: { id: true, data: true, createdAt: true, updatedAt: true },
  })
  return { table, rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

export async function createDataTable(params: {
  organizationId: string
  userId?: string | null
  name: string
  description?: string
  columns?: unknown
}) {
  const columns = dataTableColumnsSchema.parse(params.columns ?? [])
  return prisma.dataTable.create({
    data: {
      organizationId: params.organizationId,
      createdById: params.userId ?? null,
      name: params.name.trim(),
      description: params.description?.trim() ?? '',
      columns: jsonValue(columns),
    },
  })
}

/**
 * The most tables one workspace may hold.
 *
 * Creation is reachable from an agent now, and an agent that misreads its own
 * instructions can loop. A cap turns "the workspace quietly fills with
 * near-duplicate tables" into an error the run reports on the first extra one.
 */
export const MAX_DATA_TABLES_PER_ORG = 200

/**
 * Get the table with this name, creating it only if it does not exist yet.
 *
 * This is the shape an agent needs and `createDataTable` is not. A scheduled
 * agent told to "read the subscriber list" runs every morning against the same
 * workspace; a plain create would throw P2002 on day two, so the model's only
 * recovery would be to invent a new name — and the roster a human curates in
 * the UI would drift away from the one the agent reads.
 *
 * An existing table is returned UNTOUCHED, schema included. Reconciling columns
 * here would let a run whose instructions drifted rewrite the schema under rows
 * that already satisfy the old one; widening a table stays a deliberate act in
 * the UI (PATCH /api/data-tables, which re-validates every row first).
 *
 * Lookup is case-INSENSITIVE because that is how every read resolves a table by
 * name (see refWhere), while the unique index is case-sensitive. Matching the
 * index instead would let "Digest Subscribers" and "digest subscribers" both
 * exist, after which a read by name resolves to whichever row comes back first.
 */
export async function ensureDataTable(params: {
  organizationId: string
  userId?: string | null
  name: string
  description?: string
  columns?: unknown
}): Promise<{ table: Awaited<ReturnType<typeof createDataTable>>; created: boolean }> {
  const name = params.name.trim()
  if (!name) throw new Error('A data table needs a name.')

  const existing = await prisma.dataTable.findFirst({
    where: { organizationId: params.organizationId, name: { equals: name, mode: 'insensitive' } },
  })
  if (existing) return { table: existing, created: false }

  const count = await prisma.dataTable.count({ where: { organizationId: params.organizationId } })
  if (count >= MAX_DATA_TABLES_PER_ORG) {
    throw new Error(`This workspace already has the maximum of ${MAX_DATA_TABLES_PER_ORG} data tables. Delete one before creating another.`)
  }

  try {
    return { table: await createDataTable({ ...params, name }), created: true }
  } catch (error) {
    // Lost a race with a concurrent run creating the same table. The caller
    // asked for the table to exist, and it now does — that is success, not a
    // failed run.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.dataTable.findFirst({
        where: { organizationId: params.organizationId, name: { equals: name, mode: 'insensitive' } },
      })
      if (raced) return { table: raced, created: false }
    }
    throw error
  }
}

export async function insertDataTableRow(params: {
  organizationId: string
  userId?: string | null
  ref: DataTableRef
  data: unknown
}) {
  return tenantTransaction(params.organizationId, async (tx) => {
    const table = await tx.dataTable.findFirst({ where: refWhere(params.organizationId, params.ref) })
    if (!table) throw new Error('Data table not found.')
    const data = normalizeDataTableRow(params.data, table.columns)
    return tx.dataTableRow.create({
      data: {
        tableId: table.id,
        organizationId: params.organizationId,
        createdById: params.userId ?? null,
        data: jsonValue(data),
      },
      select: { id: true, data: true, createdAt: true, updatedAt: true },
    })
  })
}

export async function updateDataTableRow(params: {
  organizationId: string
  ref: DataTableRef
  rowId: string
  data: unknown
  replace?: boolean
}) {
  return tenantTransaction(params.organizationId, async (tx) => {
    const table = await tx.dataTable.findFirst({ where: refWhere(params.organizationId, params.ref) })
    if (!table) throw new Error('Data table not found.')
    const row = await tx.dataTableRow.findFirst({
      where: { id: params.rowId, tableId: table.id, organizationId: params.organizationId },
    })
    if (!row) throw new Error('Data-table row not found.')
    const patch = normalizeDataTableRow(params.data, table.columns, { partial: !params.replace })
    const data = params.replace ? patch : { ...(row.data as Record<string, unknown>), ...patch }
    // Revalidate the complete result so a partial update cannot leave a row
    // invalid after a schema change.
    const normalized = normalizeDataTableRow(data, table.columns)
    return tx.dataTableRow.update({
      where: { id: row.id, organizationId: params.organizationId },
      data: { data: jsonValue(normalized) },
      select: { id: true, data: true, createdAt: true, updatedAt: true },
    })
  })
}

export async function deleteDataTableRow(params: {
  organizationId: string
  ref: DataTableRef
  rowId: string
}) {
  return tenantTransaction(params.organizationId, async (tx) => {
    const table = await tx.dataTable.findFirst({ where: refWhere(params.organizationId, params.ref) })
    if (!table) throw new Error('Data table not found.')
    const deleted = await tx.dataTableRow.deleteMany({
      where: { id: params.rowId, tableId: table.id, organizationId: params.organizationId },
    })
    if (!deleted.count) throw new Error('Data-table row not found.')
    return { deleted: true, rowId: params.rowId }
  })
}

export async function upsertDataTableRow(params: {
  organizationId: string
  userId?: string | null
  ref: DataTableRef
  match: Record<string, unknown>
  data: unknown
}) {
  const found = await listDataTableRows(params.organizationId, params.ref, { where: params.match, limit: 2 })
  if (found.rows.length > 1) throw new Error('Upsert match is not unique; more than one row matched.')
  if (found.rows.length === 1) {
    return updateDataTableRow({
      organizationId: params.organizationId,
      ref: params.ref,
      rowId: found.rows[0].id,
      data: params.data,
    })
  }
  return insertDataTableRow(params)
}
