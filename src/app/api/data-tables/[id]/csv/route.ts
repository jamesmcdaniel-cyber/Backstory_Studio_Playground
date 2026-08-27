import { NextResponse } from 'next/server'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { csvToDataTableRows, dataTableRowsToCsv } from '@/lib/data-tables/csv'

const MAX_CSV_BYTES = 4_000_000
const idFromPath = (request: { nextUrl: { pathname: string } }) => request.nextUrl.pathname.split('/').at(-2) ?? ''
const inputJson = (value: unknown) => JSON.parse(JSON.stringify(value))

export const GET = withAuthenticatedApi(async (request, auth) => {
  const table = await prisma.dataTable.findFirst({
    where: { id: idFromPath(request), organizationId: auth.organizationId },
  })
  if (!table) throw new ApiError('Data table not found.', 404, 'DATA_TABLE_NOT_FOUND')
  const rows = await prisma.dataTableRow.findMany({
    where: { tableId: table.id, organizationId: auth.organizationId },
    orderBy: { createdAt: 'asc' },
    take: 10_001,
    select: { data: true },
  })
  if (rows.length > 10_000) throw new ApiError('CSV export is limited to 10,000 rows.', 409, 'DATA_TABLE_EXPORT_LIMIT')
  const csv = dataTableRowsToCsv(
    rows.map((row) => row.data as Record<string, unknown>),
    table.columns,
  )
  const filename = table.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'data-table'
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.csv"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const table = await prisma.dataTable.findFirst({
    where: { id: idFromPath(request), organizationId: auth.organizationId },
  })
  if (!table) throw new ApiError('Data table not found.', 404, 'DATA_TABLE_NOT_FOUND')
  const text = await request.text()
  let rows: Array<Record<string, unknown>>
  try {
    rows = csvToDataTableRows(text, table.columns)
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : String(error), 400, 'DATA_TABLE_CSV_INVALID')
  }
  const replace = request.nextUrl.searchParams.get('replace') === 'true'
  await tenantTransaction(auth.organizationId, async (tx) => {
    if (replace) await tx.dataTableRow.deleteMany({ where: { tableId: table.id, organizationId: auth.organizationId } })
    if (rows.length) {
      await tx.dataTableRow.createMany({
        data: rows.map((data) => ({
          tableId: table.id,
          organizationId: auth.organizationId,
          createdById: auth.dbUser.id,
          data: inputJson(data),
        })),
      })
    }
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: replace ? 'data_table.csv_replaced' : 'data_table.csv_imported',
    resourceType: 'data_table',
    resourceId: table.id,
    detail: { rowCount: rows.length },
  })
  return { success: true, imported: rows.length, replaced: replace }
}, { permission: 'flow.write', maxBodyBytes: MAX_CSV_BYTES })
