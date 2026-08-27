import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { createDataTable, listDataTables } from '@/lib/data-tables/service'
import { dataTableColumnsSchema, normalizeDataTableRow } from '@/lib/data-tables/schema'
import { recordAudit } from '@/lib/audit'

const tableName = z.string().trim().min(1).max(120)

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  tables: await listDataTables(auth.organizationId),
}), { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    name: tableName,
    description: z.string().max(2000).optional(),
    columns: dataTableColumnsSchema.default([]),
  }).parse(await request.json())
  try {
    const table = await createDataTable({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      ...input,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'data_table.created',
      resourceType: 'data_table',
      resourceId: table.id,
      detail: { name: table.name, columns: input.columns.length },
    })
    return { success: true, table }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError('A data table with that name already exists.', 409, 'DATA_TABLE_EXISTS')
    }
    throw error
  }
}, { permission: 'flow.write' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    id: z.string().min(1),
    name: tableName.optional(),
    description: z.string().max(2000).optional(),
    columns: dataTableColumnsSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  }).refine((value) => value.name !== undefined || value.description !== undefined || value.columns !== undefined, 'Nothing to update.')
    .parse(await request.json())

  const table = await prisma.dataTable.findFirst({ where: { id: input.id, organizationId: auth.organizationId } })
  if (!table) throw new ApiError('Data table not found.', 404, 'DATA_TABLE_NOT_FOUND')
  if (input.expectedVersion && input.expectedVersion !== table.version) {
    throw new ApiError('The table schema changed; reload it before updating.', 409, 'DATA_TABLE_STALE')
  }
  if (input.columns) {
    const rows = await prisma.dataTableRow.findMany({
      where: { tableId: table.id, organizationId: auth.organizationId },
      take: 10_001,
      select: { id: true, data: true },
    })
    if (rows.length > 10_000) {
      throw new ApiError('Schema changes for tables above 10,000 rows require an export/migration.', 409, 'DATA_TABLE_SCHEMA_MIGRATION_REQUIRED')
    }
    for (const row of rows) {
      try {
        normalizeDataTableRow(row.data, input.columns)
      } catch (error) {
        throw new ApiError(
          `Row ${row.id} is incompatible with the new schema: ${error instanceof Error ? error.message : String(error)}`,
          409,
          'DATA_TABLE_SCHEMA_CONFLICT',
        )
      }
    }
  }

  try {
    const updated = await tenantTransaction(auth.organizationId, async (tx) => {
      const result = await tx.dataTable.updateMany({
        where: {
          id: table.id,
          organizationId: auth.organizationId,
          ...(input.expectedVersion ? { version: input.expectedVersion } : {}),
        },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description.trim() } : {}),
          ...(input.columns !== undefined
            ? { columns: JSON.parse(JSON.stringify(input.columns)), version: { increment: 1 } }
            : {}),
        },
      })
      if (!result.count) throw new ApiError('The table schema changed; reload it before updating.', 409, 'DATA_TABLE_STALE')
      return tx.dataTable.findFirstOrThrow({ where: { id: table.id, organizationId: auth.organizationId } })
    })
    return { success: true, table: updated }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ApiError('A data table with that name already exists.', 409, 'DATA_TABLE_EXISTS')
    }
    throw error
  }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({ id: z.string().min(1), confirmation: z.string() }).parse(await request.json())
  const table = await prisma.dataTable.findFirst({
    where: { id: input.id, organizationId: auth.organizationId },
    select: { id: true, name: true },
  })
  if (!table) throw new ApiError('Data table not found.', 404, 'DATA_TABLE_NOT_FOUND')
  if (input.confirmation !== table.name) throw new ApiError('Type the table name to confirm deletion.', 400, 'CONFIRMATION_REQUIRED')
  await prisma.dataTable.delete({ where: { id: table.id, organizationId: auth.organizationId } })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'data_table.deleted',
    resourceType: 'data_table',
    resourceId: table.id,
    detail: { name: table.name },
  })
  return { success: true }
}, { permission: 'flow.write' })
