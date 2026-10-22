import { prisma } from '@/lib/prisma'
import { resolveHttpCredential, type HttpCredentialUseContext, type ResolvedHttpCredential } from '@/features/flows/http-auth'

/**
 * Which saved credential a warehouse call runs as.
 *
 * Databricks and Snowflake have no Nango provider here: a workspace connects
 * them by saving an HTTP credential restricted to the warehouse's own host
 * (dbc-….cloud.databricks.com, <account>.snowflakecomputing.com). The host is
 * the binding — the same rule the HTTP API tool and the ROI pull follow — so a
 * tool call never carries a secret, only (at most) the host it wants.
 *
 * Among several credentials for one host the acting person's own wins, then a
 * legacy unowned one, then the most recently verified: a credential somebody
 * else saved is still usable (an admin sets the warehouse up once), but never
 * preferred over yours.
 */

export type WarehouseKind = 'databricks' | 'snowflake'

export class WarehouseCredentialError extends Error {}

/** Host suffixes that identify each warehouse. Lowercase, leading dot. */
export const WAREHOUSE_HOST_SUFFIXES: Record<WarehouseKind, readonly string[]> = {
  databricks: ['.cloud.databricks.com', '.azuredatabricks.net', '.gcp.databricks.com', '.databricks.us'],
  snowflake: ['.snowflakecomputing.com'],
}

export const WAREHOUSE_LABEL: Record<WarehouseKind, string> = { databricks: 'Databricks', snowflake: 'Snowflake' }

const EXAMPLE_HOST: Record<WarehouseKind, string> = {
  databricks: 'dbc-a1b2c3d4-e5f6.cloud.databricks.com',
  snowflake: '<account>.snowflakecomputing.com',
}

const CREDENTIAL_HINT: Record<WarehouseKind, string> = {
  databricks: 'a Databricks personal access token as a bearer credential, or OAuth client credentials',
  snowflake: 'a Snowflake programmatic access token, a key pair, or an OAuth token',
}

export function warehouseKindForHost(host: string): WarehouseKind | null {
  const lowered = host.toLowerCase()
  for (const kind of Object.keys(WAREHOUSE_HOST_SUFFIXES) as WarehouseKind[]) {
    if (WAREHOUSE_HOST_SUFFIXES[kind].some((suffix) => lowered.endsWith(suffix))) return kind
  }
  return null
}

/** The plain-English sentence every "no credential" failure ends with. */
export function missingWarehouseCredentialMessage(kind: WarehouseKind, host?: string): string {
  const target = host || EXAMPLE_HOST[kind]
  return `No saved ${WAREHOUSE_LABEL[kind]} credential${host ? ` for ${host}` : ''}. Save a credential for ${target} in Integrations (${CREDENTIAL_HINT[kind]}, restricted to that host) and run again.`
}

type CredentialRow = { id: string; allowedHost: string; userId: string | null; status: string; lastVerifiedAt: Date | null }

/**
 * Data access, swappable in tests (the clients themselves never touch the
 * database, so the rest of the warehouse code is tested without one).
 */
export const warehouseCredentialStore = {
  async rows(organizationId: string, where: { host?: string; kind?: WarehouseKind }): Promise<CredentialRow[]> {
    return prisma.httpCredential.findMany({
      where: {
        organizationId,
        status: { in: ['verified', 'error'] },
        ...(where.host
          ? { allowedHost: where.host }
          : where.kind
            ? { OR: WAREHOUSE_HOST_SUFFIXES[where.kind].map((suffix) => ({ allowedHost: { endsWith: suffix } })) }
            : { OR: Object.values(WAREHOUSE_HOST_SUFFIXES).flat().map((suffix) => ({ allowedHost: { endsWith: suffix } })) }),
      },
      select: { id: true, allowedHost: true, userId: true, status: true, lastVerifiedAt: true },
      take: 50,
    })
  },
  resolve(id: string, organizationId: string, context: HttpCredentialUseContext): Promise<ResolvedHttpCredential> {
    return resolveHttpCredential(id, organizationId, context)
  },
}

function preferred(rows: CredentialRow[], actorUserId: string | null): CredentialRow | undefined {
  const rank = (row: CredentialRow) => (row.userId && row.userId === actorUserId ? 0 : row.userId === null ? 1 : 2) * 2 + (row.status === 'verified' ? 0 : 1)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.lastVerifiedAt?.getTime() ?? 0) - (a.lastVerifiedAt?.getTime() ?? 0))[0]
}

/** Every warehouse host this workspace holds a usable credential for, by kind. */
export async function listWarehouseCredentialHosts(organizationId: string): Promise<Record<WarehouseKind, string[]>> {
  const rows = await warehouseCredentialStore.rows(organizationId, {})
  const hosts: Record<WarehouseKind, string[]> = { databricks: [], snowflake: [] }
  for (const row of rows) {
    const host = row.allowedHost.toLowerCase()
    const kind = warehouseKindForHost(host)
    if (kind && !hosts[kind].includes(host)) hosts[kind].push(host)
  }
  return hosts
}

/** The saved credential for exactly this host, or a plain-English reason there is none. */
export async function warehouseCredentialForHost(
  organizationId: string,
  host: string,
  options: { kind: WarehouseKind; actorUserId: string | null; consumer: string; missingMessage?: string },
): Promise<ResolvedHttpCredential> {
  const row = preferred(await warehouseCredentialStore.rows(organizationId, { host }), options.actorUserId)
  if (!row) throw new WarehouseCredentialError(options.missingMessage ?? missingWarehouseCredentialMessage(options.kind, host))
  return warehouseCredentialStore.resolve(row.id, organizationId, { actorUserId: options.actorUserId, consumer: options.consumer })
}

/**
 * The host a call runs against. An explicit host must be one of the kind's
 * hosts (and must have a credential — checked by warehouseCredentialForHost);
 * without one, the workspace's only saved host for the kind is used, which is
 * what lets an imported step run without anyone typing the account address.
 */
export async function resolveWarehouseHost(organizationId: string, kind: WarehouseKind, hostArg: string | undefined): Promise<string> {
  const explicit = normalizeWarehouseHost(hostArg ?? '', kind)
  if (explicit) return explicit
  const rows = await warehouseCredentialStore.rows(organizationId, { kind })
  const hosts = [...new Set(rows.map((row) => row.allowedHost.toLowerCase()).filter((host) => warehouseKindForHost(host) === kind))]
  if (hosts.length === 1) return hosts[0]
  if (hosts.length === 0) throw new WarehouseCredentialError(missingWarehouseCredentialMessage(kind))
  throw new WarehouseCredentialError(`This workspace has ${WAREHOUSE_LABEL[kind]} credentials for several hosts (${hosts.slice(0, 5).join(', ')}) — pass "host" to choose one.`)
}

const HOST_PATTERN = /^[a-z0-9][a-z0-9.-]{2,250}$/

/**
 * A pasted URL, account identifier or host → the bare host, or '' when none
 * was given. A Snowflake account identifier (`myorg-myaccount`,
 * `xy12345.us-east-1`) is completed to its snowflakecomputing.com host.
 */
export function normalizeWarehouseHost(value: string, kind: WarehouseKind): string {
  const trimmed = value.trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase()
  if (!trimmed) return ''
  const host = kind === 'snowflake' && !trimmed.endsWith('.snowflakecomputing.com') && !trimmed.includes('snowflakecomputing')
    ? `${trimmed}.snowflakecomputing.com`
    : trimmed
  if (!HOST_PATTERN.test(host) || !host.includes('.') || warehouseKindForHost(host) !== kind) {
    throw new WarehouseCredentialError(`"${value}" is not a ${WAREHOUSE_LABEL[kind]} host (expected something like ${EXAMPLE_HOST[kind]}).`)
  }
  return host
}
