import { sqlIsReadOnly } from './sql-classify'

/**
 * Read vs write for every warehouse tool — import-light (no network, no
 * database) so the import capability report and the tool planes share one
 * answer.
 *
 * SQL tools are classified per CALL by their statement. Every other tool is
 * classified by name: the reads below never change anything in the
 * workspace; every other name — uploads, deletes, creates, updates, upserts,
 * job runs, and any tool this list has not heard of — is a write, so it goes
 * through the approval gate.
 */

const SQL_TOOLS = new Set(['databricks_sql_query', 'snowflake_sql_query'])

export const DATABRICKS_READ_TOOLS: ReadonlySet<string> = new Set([
  // Files
  'databricks_files_download',
  'databricks_files_list',
  'databricks_files_get_metadata',
  // Genie (asking creates a conversation message, which changes no data)
  'databricks_genie_ask',
  'databricks_genie_get_space',
  'databricks_genie_get_message',
  'databricks_genie_get_query_result',
  'databricks_genie_execute_query',
  // Model Serving
  'databricks_serving_query',
  'databricks_serving_list',
  'databricks_serving_get',
  // Unity Catalog
  'databricks_unity_catalog_list',
  'databricks_unity_catalog_get',
  // Vector Search
  'databricks_vector_search_query',
  'databricks_vector_search_list_indexes',
  'databricks_vector_search_get_index',
  'databricks_vector_search_list_endpoints',
])

export const DATABRICKS_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'databricks_run_job',
  'databricks_files_upload',
  'databricks_files_delete',
  'databricks_files_mkdir',
  'databricks_files_rmdir',
  'databricks_unity_catalog_create',
  'databricks_unity_catalog_update',
  'databricks_unity_catalog_delete',
  'databricks_vector_search_create_index',
  'databricks_vector_search_upsert',
  'databricks_vector_search_delete_data',
])

/**
 * Per-call write classification. Without the call's args (a catalog or a
 * plane-level decision) a query tool counts as a write: it CAN write.
 */
export function warehouseToolIsWrite(toolName: string, args?: Record<string, unknown>): boolean {
  if (SQL_TOOLS.has(toolName)) return !args || !sqlIsReadOnly(args.statement)
  return !DATABRICKS_READ_TOOLS.has(toolName)
}

/** True when the name is any known warehouse tool (SQL or Databricks API). */
export function isKnownWarehouseToolName(toolName: string): boolean {
  return SQL_TOOLS.has(toolName) || DATABRICKS_READ_TOOLS.has(toolName) || DATABRICKS_WRITE_TOOLS.has(toolName)
}
