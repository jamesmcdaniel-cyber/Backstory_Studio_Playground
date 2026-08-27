import {
  deleteDataTableRow,
  insertDataTableRow,
  listDataTableRows,
  listDataTables,
  updateDataTableRow,
  upsertDataTableRow,
  type DataTableRef,
} from '@/lib/data-tables/service'

const tableRefProperties = {
  tableId: { type: 'string', description: 'The table id. Pass this or tableName.' },
  tableName: { type: 'string', description: 'The exact table name. Pass this or tableId.' },
}

export const DATA_TABLE_TOOLS = [
  {
    name: 'data_table_list_tables',
    description: 'List durable data tables in this workspace and their typed column schemas.',
    isWrite: false,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'data_table_get_rows',
    description: 'Read rows from a durable workspace data table, optionally matching exact field values.',
    isWrite: false,
    inputSchema: {
      type: 'object',
      properties: {
        ...tableRefProperties,
        where: { type: 'object', description: 'Exact field/value matches.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
      },
    },
  },
  {
    name: 'data_table_insert_row',
    description: 'Insert one schema-validated row into a durable workspace data table.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: { ...tableRefProperties, data: { type: 'object', description: 'Column values for the new row.' } },
      required: ['data'],
    },
  },
  {
    name: 'data_table_update_row',
    description: 'Update one durable data-table row by id. Unspecified columns are preserved.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...tableRefProperties,
        rowId: { type: 'string' },
        data: { type: 'object', description: 'Columns to update.' },
      },
      required: ['rowId', 'data'],
    },
  },
  {
    name: 'data_table_upsert_row',
    description: 'Update the one row matching exact values, or insert a row when none matches.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...tableRefProperties,
        match: { type: 'object', description: 'Exact unique field/value match.' },
        data: { type: 'object', description: 'Columns to insert or update.' },
      },
      required: ['match', 'data'],
    },
  },
  {
    name: 'data_table_delete_row',
    description: 'Delete one durable data-table row by id.',
    isWrite: true,
    inputSchema: {
      type: 'object',
      properties: { ...tableRefProperties, rowId: { type: 'string' } },
      required: ['rowId'],
    },
  },
] as const

export function dataTableToolIsWrite(name: string): boolean {
  return DATA_TABLE_TOOLS.find((tool) => tool.name === name)?.isWrite ?? true
}

function ref(args: Record<string, unknown>): DataTableRef {
  return {
    ...(typeof args.tableId === 'string' ? { tableId: args.tableId } : {}),
    ...(typeof args.tableName === 'string' ? { tableName: args.tableName } : {}),
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`)
  return value as Record<string, unknown>
}

/** Runtime client used by both flow Tool nodes and attached agents. */
export class DataTableToolClient {
  constructor(
    private readonly organizationId: string,
    private readonly userId?: string | null,
  ) {}

  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'data_table_list_tables':
        return { tables: await listDataTables(this.organizationId) }
      case 'data_table_get_rows': {
        const result = await listDataTableRows(this.organizationId, ref(args), {
          ...(args.where ? { where: record(args.where, 'where') } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
        })
        return { table: { id: result.table.id, name: result.table.name }, rows: result.rows, hasMore: result.hasMore }
      }
      case 'data_table_insert_row':
        return insertDataTableRow({
          organizationId: this.organizationId,
          userId: this.userId,
          ref: ref(args),
          data: record(args.data, 'data'),
        })
      case 'data_table_update_row':
        return updateDataTableRow({
          organizationId: this.organizationId,
          ref: ref(args),
          rowId: String(args.rowId ?? ''),
          data: record(args.data, 'data'),
        })
      case 'data_table_upsert_row':
        return upsertDataTableRow({
          organizationId: this.organizationId,
          userId: this.userId,
          ref: ref(args),
          match: record(args.match, 'match'),
          data: record(args.data, 'data'),
        })
      case 'data_table_delete_row':
        return deleteDataTableRow({
          organizationId: this.organizationId,
          ref: ref(args),
          rowId: String(args.rowId ?? ''),
        })
      default:
        throw new Error(`Unknown data-table tool "${name}".`)
    }
  }
}
