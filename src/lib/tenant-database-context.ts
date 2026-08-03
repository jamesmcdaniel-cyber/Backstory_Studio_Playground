import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma } from '@prisma/client'

export type TenantDatabaseContext = {
  organizationId: string
  transaction: Prisma.TransactionClient
}

export const tenantDatabaseContext = new AsyncLocalStorage<TenantDatabaseContext>()

export function exactOrganizationId(value: unknown): string | null {
  const found = new Set<string>()
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'organizationId') {
        if (typeof item === 'string') found.add(item)
        else if (item && typeof item === 'object') {
          const filter = item as { equals?: unknown; in?: unknown }
          if (typeof filter.equals === 'string') found.add(filter.equals)
          if (Array.isArray(filter.in) && filter.in.length === 1 && typeof filter.in[0] === 'string') found.add(filter.in[0])
        }
      }
      visit(item)
    }
  }
  visit(value)
  return found.size === 1 ? [...found][0] : null
}
