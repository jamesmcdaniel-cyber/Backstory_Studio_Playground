/**
 * What an integration can actually do here, derived from the SAME registry the
 * agents execute against (src/lib/nango/provider-tools.ts) — so the detail
 * dialog can never drift into claiming capabilities the runtime doesn't have,
 * and a newly wired tool appears in the dialog with no extra step.
 *
 * Pure: the registry is a static module; no DB, no env.
 */

import { fromNangoProviderKey } from '@/lib/connectors/registry'
import { toolsForProvider } from '@/lib/nango/provider-tools'

export interface CapabilityItem {
  label: string
  description: string
}

export interface IntegrationCapabilities {
  /** Canonical provider key ('gmail', 'github', …). */
  provider: string
  label: string
  /** Read tools — list/search/get; these run without the approval gate. */
  reads: CapabilityItem[]
  /** Write tools — send/create/update; approval-gated, acting as the user. */
  writes: CapabilityItem[]
}

/**
 * 'github_list_repositories' → 'List repositories'. The provider prefix is
 * dropped, the rest reads as a sentence — no raw identifiers in the UI.
 */
export function humanizeToolName(name: string, provider: string): string {
  const stripped = name.startsWith(`${provider}_`) ? name.slice(provider.length + 1) : name
  const words = stripped.split('_').filter(Boolean)
  if (words.length === 0) return name
  return words.map((word, index) => (index === 0 ? word[0].toUpperCase() + word.slice(1) : word)).join(' ')
}

/**
 * Capabilities for a Nango config key, resolved through the same normaliser
 * the runtime uses so dashboard naming variants ('google-mail', 'gmail-v2')
 * land on the right provider. Unknown providers get empty lists — connectable,
 * nothing wired — never null, so the dialog can say so honestly.
 */
export function integrationCapabilities(configKey: string): IntegrationCapabilities {
  const { key, label } = fromNangoProviderKey(configKey)
  const tools = toolsForProvider(key)
  const item = (tool: { name: string; description: string }): CapabilityItem => ({
    label: humanizeToolName(tool.name, key),
    description: tool.description,
  })
  return {
    provider: key,
    label,
    reads: tools.filter((tool) => !tool.isWrite).map(item),
    writes: tools.filter((tool) => tool.isWrite).map(item),
  }
}
