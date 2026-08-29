/**
 * The adapter regression monitor, as an agent tool.
 *
 * This is what makes the Adapter Regression Monitor template executable rather
 * than descriptive. It is a read plane: replaying a golden touches no upstream
 * system, needs no credential, and changes nothing — the whole point is that it
 * runs on a machine that has never been connected to Salesforce.
 *
 * The report handed back is the structured one, not prose. An agent asked to
 * "catch functional regressions before connector changes break reusable
 * workflow patterns" has to say which contract broke and what it protected,
 * and it can only do that if the tool gives it those facts rather than a
 * pass/fail count.
 */

import type { ToolDefinition } from '@/lib/llm/model-runner'
import { ADAPTER_FAMILIES, type AdapterFamily } from './fixtures'
import { replayAdapterFixtures } from './replay'

export function adapterTools(): ToolDefinition[] {
  return [
    {
      name: 'replay_adapter_fixtures',
      description:
        'Replay the recorded golden payloads through the live CRM, meeting, identity, delivery, calendar and research adapters and report any drift. Each result names the contract the fixture protects, so a failure can be explained rather than just counted. Runs entirely offline — it calls no upstream system and needs no connected account.',
      inputSchema: {
        type: 'object',
        properties: {
          family: {
            type: 'string',
            enum: [...ADAPTER_FAMILIES],
            description: 'Limit the replay to one adapter family. Omit to check them all.',
          },
        },
      },
    },
  ]
}

export class AdapterToolClient {
  async executeTool(_serverUrl: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'replay_adapter_fixtures') throw new Error(`Unknown adapter tool "${name}".`)
    const requested = String(args.family ?? '')
    const family = (ADAPTER_FAMILIES as readonly string[]).includes(requested)
      ? (requested as AdapterFamily)
      : undefined
    const report = await replayAdapterFixtures(family ? { family } : {})
    return {
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      byFamily: report.byFamily,
      // Only drift carries its expected/actual payload. Echoing every passing
      // fixture's golden back would be most of the response and none of the
      // information — the monitor's output is the exceptions.
      drift: report.outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => ({
          fixture: outcome.id,
          family: outcome.family,
          contract: outcome.pins,
          ...(outcome.error ? { error: outcome.error } : { expected: outcome.expected, actual: outcome.actual }),
        })),
      checked: report.outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.id),
    }
  }
}
