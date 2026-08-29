/**
 * Offline replay of the adapter golden fixtures.
 *
 * Every adapter in this codebase already takes its I/O through a seam — the
 * Nango specs take `proxy = defaultProxy()`, the transforms are pure — so a
 * fixture can be driven through the REAL adapter with nothing stubbed but the
 * transport. That is what makes this a regression check rather than a
 * re-implementation: the code under test is the code that runs in production.
 *
 * The report is deliberately shaped for two consumers at once — a CI assertion
 * and an agent writing a status report — so every drift carries the fixture's
 * `pins` line, which says what the golden was protecting. "salesforce_query
 * changed" is not actionable; "SOQL travels as the `q` query parameter" is.
 */

import { DELIVERY_TOOLS, type NangoProxyArgs, type DeliveryConnection } from '@/lib/nango/delivery'
import { NANGO_PROVIDER_TOOLS } from '@/lib/nango/provider-tools'
import { normalizeSlackEvent } from '@/lib/activity/normalize'
import { resolveMention } from '@/lib/slack/mention'
import { normalizeBraveResults } from '@/lib/integrations/research'
import {
  ADAPTER_FIXTURES,
  type AdapterFamily,
  type AdapterFixture,
  type RequestFixture,
  type TransformFixture,
} from './fixtures'

/** A fixture connection. Never reaches a network — the proxy is captured. */
const FIXTURE_CONNECTION: DeliveryConnection = {
  connectionId: 'fixture-connection',
  providerConfigKey: 'fixture',
  scope: 'user',
}

/**
 * The pure transforms a fixture may name, each adapted to (input) -> output.
 *
 * Each wrapper projects only the fields the golden asserts. A transform's full
 * output carries timestamps and derived ids that legitimately move, and pinning
 * those would make the monitor cry wolf every time an unrelated field is added
 * — the fastest way to teach a team to ignore a regression check.
 */
const TRANSFORM_ADAPTERS: Record<string, (input: any) => unknown> = {
  normalizeSlackEvent: (input) => {
    const result = normalizeSlackEvent('fixture-org', input, {
      receivedAt: new Date('2026-01-01T00:00:00Z'),
      botUserId: 'U_BOT',
    })
    if (!result) return null
    return {
      kind: result.kind,
      sourceEventId: result.sourceEventId,
      actorExternalId: result.actorExternalId,
      selfOrigin: result.selfOrigin,
    }
  },
  resolveMention: (input) => {
    const result = resolveMention(input)
    return result.kind === 'agent'
      ? { kind: result.kind, agentId: result.agent.id, prompt: result.prompt }
      : { kind: result.kind }
  },
  normalizeBraveResults: (input) => normalizeBraveResults(input, 10),
}

export interface FixtureOutcome {
  id: string
  family: AdapterFamily
  pins: string
  ok: boolean
  /** Present only on drift: what the golden expected and what the adapter did. */
  expected?: unknown
  actual?: unknown
  error?: string
}

export interface ReplayReport {
  total: number
  passed: number
  failed: number
  byFamily: Array<{ family: AdapterFamily; total: number; failed: number }>
  /** Every outcome, so a caller can show passes; drift is listed first. */
  outcomes: FixtureOutcome[]
}

/** Resolve a tool name across the provider registry AND the delivery adapters. */
function findAdapter(tool: string) {
  const spec = NANGO_PROVIDER_TOOLS.find((entry) => entry.name === tool)
  if (spec) return spec.run
  const delivery = DELIVERY_TOOLS.find((entry) => entry.name === tool)
  return delivery?.run
}

async function replayRequest(fixture: RequestFixture): Promise<FixtureOutcome> {
  const base = { id: fixture.id, family: fixture.family, pins: fixture.pins }
  const run = findAdapter(fixture.tool)
  if (!run) {
    // A fixture naming a tool that no longer exists is itself a regression: the
    // adapter was renamed or deleted and every caller referencing it is broken.
    return { ...base, ok: false, error: `No adapter named "${fixture.tool}" is registered.` }
  }

  let captured: NangoProxyArgs | undefined
  const proxy = async (args: NangoProxyArgs) => {
    captured = args
    return { data: {} }
  }

  try {
    await run(FIXTURE_CONNECTION, fixture.args, proxy)
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (!captured) return { ...base, ok: false, error: 'The adapter never issued a request.' }

  // Only the fields the golden names are compared. The connection identifiers
  // are the harness's, and an adapter that starts sending a header the fixture
  // never claimed should not read as drift in what the fixture DOES pin.
  const actual: Record<string, unknown> = { method: captured.method, endpoint: captured.endpoint }
  if (fixture.expect.params !== undefined) actual.params = captured.params
  if (fixture.expect.data !== undefined) actual.data = captured.data
  if (fixture.expect.headers !== undefined) actual.headers = captured.headers

  const ok = stableEqual(actual, fixture.expect as Record<string, unknown>)
  return ok ? { ...base, ok: true } : { ...base, ok: false, expected: fixture.expect, actual }
}

function replayTransform(fixture: TransformFixture): FixtureOutcome {
  const base = { id: fixture.id, family: fixture.family, pins: fixture.pins }
  const transform = TRANSFORM_ADAPTERS[fixture.transform]
  if (!transform) return { ...base, ok: false, error: `No transform named "${fixture.transform}" is registered.` }
  try {
    const actual = transform(fixture.input)
    const ok = stableEqual(actual, fixture.expect)
    return ok ? { ...base, ok: true } : { ...base, ok: false, expected: fixture.expect, actual }
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Structural comparison, insensitive to key order.
 *
 * Key order is not part of any of these contracts — a request body is JSON and
 * a transform's output is consumed by field — so ordering differences would be
 * pure false positives.
 */
function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    )
  }
  return value
}

/** Replay every fixture (or one family's), offline. */
export async function replayAdapterFixtures(
  options: { family?: AdapterFamily; fixtures?: AdapterFixture[] } = {},
): Promise<ReplayReport> {
  const selected = (options.fixtures ?? ADAPTER_FIXTURES).filter(
    (fixture) => !options.family || fixture.family === options.family,
  )

  const outcomes: FixtureOutcome[] = []
  for (const fixture of selected) {
    outcomes.push(fixture.kind === 'request' ? await replayRequest(fixture) : replayTransform(fixture))
  }

  const byFamily = new Map<AdapterFamily, { family: AdapterFamily; total: number; failed: number }>()
  for (const outcome of outcomes) {
    const entry = byFamily.get(outcome.family) ?? { family: outcome.family, total: 0, failed: 0 }
    entry.total += 1
    if (!outcome.ok) entry.failed += 1
    byFamily.set(outcome.family, entry)
  }

  return {
    total: outcomes.length,
    passed: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    byFamily: [...byFamily.values()],
    // Drift first: a report an agent reads top-down should lead with what broke.
    outcomes: [...outcomes].sort((a, b) => Number(a.ok) - Number(b.ok)),
  }
}

/** One-line drift summaries, for a run log or a failed assertion message. */
export function describeDrift(report: ReplayReport): string[] {
  return report.outcomes
    .filter((outcome) => !outcome.ok)
    .map((outcome) =>
      outcome.error
        ? `${outcome.id}: ${outcome.error} (pins: ${outcome.pins})`
        : `${outcome.id}: expected ${JSON.stringify(outcome.expected)}, got ${JSON.stringify(outcome.actual)} (pins: ${outcome.pins})`,
    )
}
