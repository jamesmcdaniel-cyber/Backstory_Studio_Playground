/**
 * Which hosts belong to which warehouse. Pure (no database, no server-only
 * imports) so the browser can use the same rule the server binds credentials
 * by — the connect form checks the address someone types against exactly the
 * suffixes the warehouse tools later resolve a credential with.
 */

export type WarehouseKind = 'databricks' | 'snowflake'

/** Host suffixes that identify each warehouse. Lowercase, leading dot. */
export const WAREHOUSE_HOST_SUFFIXES: Record<WarehouseKind, readonly string[]> = {
  databricks: ['.cloud.databricks.com', '.azuredatabricks.net', '.gcp.databricks.com', '.databricks.us'],
  snowflake: ['.snowflakecomputing.com'],
}

export const WAREHOUSE_LABEL: Record<WarehouseKind, string> = { databricks: 'Databricks', snowflake: 'Snowflake' }

export function warehouseKindForHost(host: string): WarehouseKind | null {
  const lowered = host.toLowerCase()
  for (const kind of Object.keys(WAREHOUSE_HOST_SUFFIXES) as WarehouseKind[]) {
    if (WAREHOUSE_HOST_SUFFIXES[kind].some((suffix) => lowered.endsWith(suffix))) return kind
  }
  return null
}

/**
 * The warehouse a catalog entry stands for, by its provider slug or name.
 * Nango's catalog lists Snowflake and Databricks, but a Nango connection to
 * either reaches none of the warehouse tools — those run on a saved credential
 * bound to the warehouse host. The integrations grid uses this to send those
 * two cards to the credential form instead of Nango's Connect UI.
 */
export function warehouseKindForProvider(provider: string | null | undefined): WarehouseKind | null {
  const value = (provider ?? '').toLowerCase()
  if (value.includes('snowflake')) return 'snowflake'
  if (value.includes('databricks')) return 'databricks'
  return null
}
