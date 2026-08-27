import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  deleteDataTableRow,
  insertDataTableRow,
  listDataTableRows,
  updateDataTableRow,
  upsertDataTableRow,
} from '@/lib/data-tables/service'
import { recordAudit } from '@/lib/audit'

function tableId(request: { nextUrl: { pathname: string } }): string {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Data table id is required.', 400, 'DATA_TABLE_ID_REQUIRED')
  return id
}

function objectQuery(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // standardized below
  }
  throw new ApiError('where must be a JSON object.', 400, 'INVALID_WHERE')
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  let result
  try {
    result = await listDataTableRows(auth.organizationId, { tableId: tableId(request) }, {
      where: objectQuery(request.nextUrl.searchParams.get('where')),
      limit: Number(request.nextUrl.searchParams.get('limit') || 100),
      offset: Number(request.nextUrl.searchParams.get('offset') || 0),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'Data table not found.') {
      throw new ApiError(error.message, 404, 'DATA_TABLE_NOT_FOUND')
    }
    throw error
  }
  return {
    success: true,
    table: { id: result.table.id, name: result.table.name, columns: result.table.columns, version: result.table.version },
    rows: result.rows,
    hasMore: result.hasMore,
  }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    data: z.record(z.string(), z.unknown()),
    match: z.record(z.string(), z.unknown()).optional(),
  }).parse(await request.json())
  try {
    const row = input.match
      ? await upsertDataTableRow({
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          ref: { tableId: tableId(request) },
          match: input.match,
          data: input.data,
        })
      : await insertDataTableRow({
          organizationId: auth.organizationId,
          userId: auth.dbUser.id,
          ref: { tableId: tableId(request) },
          data: input.data,
        })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: input.match ? 'data_table.row_upserted' : 'data_table.row_created',
      resourceType: 'data_table',
      resourceId: tableId(request),
      detail: { rowId: row.id },
    })
    return { success: true, row }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(error instanceof Error ? error.message : String(error), 400, 'DATA_TABLE_ROW_INVALID')
  }
}, { permission: 'flow.write' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    rowId: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    replace: z.boolean().default(false),
  }).parse(await request.json())
  try {
    const row = await updateDataTableRow({
      organizationId: auth.organizationId,
      ref: { tableId: tableId(request) },
      ...input,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'data_table.row_updated',
      resourceType: 'data_table',
      resourceId: tableId(request),
      detail: { rowId: row.id, replace: input.replace },
    })
    return { success: true, row }
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error), 400, 'DATA_TABLE_ROW_INVALID')
  }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { rowId } = z.object({ rowId: z.string().min(1) }).parse(await request.json())
  try {
    const result = {
      success: true,
      ...(await deleteDataTableRow({
        organizationId: auth.organizationId,
        ref: { tableId: tableId(request) },
        rowId,
      })),
    }
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'data_table.row_deleted',
      resourceType: 'data_table',
      resourceId: tableId(request),
      detail: { rowId },
    })
    return result
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error), 404, 'DATA_TABLE_ROW_NOT_FOUND')
  }
}, { permission: 'flow.write' })
