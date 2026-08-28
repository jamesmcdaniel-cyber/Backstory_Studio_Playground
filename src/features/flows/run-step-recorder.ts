import { prisma } from '@/lib/prisma'
import { recordCompletedSpan } from '@/lib/observability/otel'
import { shouldPersistInterpreterStep, jsonValue } from './run-step-persistence'
import { trackDetached } from '@/lib/flows/keep-alive'
import { broadcastFlowRunTick } from '@/lib/flows/run-stream'
import { truncateWithMarker } from '@/lib/flows/truncate'
import type { FlowItem } from '@/lib/flows/items'

type FlowRow = NonNullable<Awaited<ReturnType<typeof prisma.flow.findFirst>>>
type FlowRunRow = NonNullable<Awaited<ReturnType<typeof prisma.flowRun.findFirst>>>

/**
 * The interpreter's per-step callback: emits a trace span, broadcasts the tick
 * the run panel narrates from, and persists the FlowRunStep rows the
 * interpreter owns (containers, per-item aggregates, interpreter-native nodes).
 *
 * Carved out of `runFlowExecutionInner` alongside ./run-action-step. Those two
 * are the run's only writers of step rows — this one for steps the INTERPRETER
 * decides, that one for steps the ENGINE executes — and keeping them as
 * separate named modules is what makes that split visible; inline they were two
 * unlabelled closures 300 lines apart in the same function body.
 */
export interface OnStepContext {
  flow: FlowRow
  run: FlowRunRow
  /** Node type by id, for span attributes and the persistence decision. */
  nodeTypeById: Map<string, string | undefined>
  /**
   * Shared, MUTABLE step ordinal — the same counter ./run-action-step draws
   * from, so interpreter-written and engine-written rows share one sequence and
   * the run panel orders them as they actually happened.
   */
  nextOrder: () => number
  /**
   * Shared sink for detached row writes. Step persistence is deliberately NOT
   * awaited inside the walk — a slow write would stall the interpreter — so the
   * promises land here and the engine drains them once before finalizing.
   */
  pending: Promise<unknown>[]
}

export function createOnStep(ctx: OnStepContext) {
  const { flow, run, nodeTypeById, pending } = ctx
  const onStep = (outcome: { nodeId: string; iterationKey?: string; status: string; input?: unknown; output?: unknown; items?: FlowItem[]; error?: string; warnings?: string[]; logs?: string[]; startedAt: Date; finishedAt: Date }) => {
    recordCompletedSpan('flow.step', {
      startTime: outcome.startedAt,
      endTime: outcome.finishedAt,
      failed: outcome.status === 'failed',
      attributes: {
        'backstory.flow.id': flow.id,
        'backstory.flow.run_id': run.id,
        'backstory.flow.node_id': outcome.nodeId,
        'backstory.flow.node_type': nodeTypeById.get(outcome.nodeId),
        'backstory.flow.step_status': outcome.status,
        'backstory.flow.iteration': outcome.iterationKey,
      },
    })
    // Realtime nudge: tell the builder a step changed so it refreshes at once
    // (no output on the wire — see run-stream.ts). Fire-and-forget; no-op locally.
    trackDetached(broadcastFlowRunTick(run.id, { nodeId: outcome.nodeId, status: outcome.status }))
    const rowKey = outcome.iterationKey ?? outcome.nodeId
    if (!shouldPersistInterpreterStep(nodeTypeById.get(outcome.nodeId))) {
      // Adapter (agent/tool/http/ai/subflow/code/knowledge) rows are written
      // by the adapter — but the value DOWNSTREAM CONSUMED is computed after
      // the adapter returns (asStructured / structured-output parse), so:
      // - success: overwrite the row's output with the consumed value, so the
      //   run panel shows what later steps actually read AND a resume replays
      //   the step from the consumed shape (a structured agent replayed from
      //   its raw text would break every {{step.x.output.field}} reference).
      // - per-item aggregate: the children each have a #i row, but the
      //   aggregate array had no row anywhere — create it when the update
      //   matched nothing.
      if (outcome.status === 'succeeded' && outcome.output !== undefined) {
        const aggregateOrder = ctx.nextOrder()
        pending.push(
          // The check-then-write (updateMany, then create only if it matched
          // nothing) is a single transaction so two concurrent per-item
          // completions racing this same rowKey can't both see count 0 and
          // both create a duplicate aggregate row.
          prisma.$transaction(async (tx) => {
            // Warnings only ever ADD here (never null out): the interpreter's
            // producers (empty result, item-policy counts) and any adapter-side
            // note are disjoint by construction, so a present outcome.warnings
            // is authoritative for this row.
            const warningsPatch = outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}
            const updated = await tx.flowRunStep.updateMany({
              where: { flowRunId: run.id, nodeId: rowKey, status: 'succeeded' },
              data: {
                output: jsonValue(outcome.output),
                ...(outcome.items ? { items: jsonValue(outcome.items) } : {}),
                ...warningsPatch,
              },
            })
            if (updated.count === 0) {
              await tx.flowRunStep.create({
                data: {
                  flowRunId: run.id,
                  nodeId: rowKey,
                  order: aggregateOrder,
                  status: 'succeeded',
                  input: jsonValue(outcome.input ?? {}),
                  output: jsonValue(outcome.output ?? null),
                  ...(outcome.items ? { items: jsonValue(outcome.items) } : {}),
                  ...warningsPatch,
                  startedAt: outcome.startedAt,
                  finishedAt: outcome.finishedAt,
                },
              })
            }
          }).catch(() => undefined),
        )
        return
      }
      // The adapter stores NULL output on failure. For an onError
      // route/continue failure the interpreter computed the {error, input}
      // pass-through here — backfill it onto the failed row so a RESUME
      // replays this step from its stored output (and re-takes the error
      // edge) instead of re-executing it, which would duplicate an external
      // write and could diverge the path if the transient error has since
      // cleared. Other emits are no-ops.
      if (outcome.status === 'failed') {
        const failedOrder = ctx.nextOrder()
        pending.push(
          // Same reasoning as the succeeded branch: the check-then-write
          // (updateMany/count, then create only if nothing matched) is one
          // transaction so a concurrent emit for the same rowKey can't both
          // observe "no row" and both create a duplicate.
          prisma.$transaction(async (tx) => {
            // Same additive rule as the succeeded branch above: warnings only
            // ever ADD. Needed here so a retried 'agent' step (whose row is
            // created/finished per attempt by `runAgent`, before this attempt
            // count exists) still gets its attempt-error trail persisted even
            // when the failure itself carries no output patch.
            const warningsPatch = outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}
            if (outcome.output !== undefined || outcome.items || Object.keys(warningsPatch).length) {
              const updated = await tx.flowRunStep.updateMany({
                where: { flowRunId: run.id, nodeId: rowKey, status: 'failed' },
                data: {
                  ...(outcome.output !== undefined ? { output: jsonValue(outcome.output) } : {}),
                  ...(outcome.items ? { items: jsonValue(outcome.items) } : {}),
                  ...warningsPatch,
                },
              })
              if (updated.count > 0) return
            }
            // A resolution failure (missing/foreign data reference) fails the
            // step BEFORE its adapter runs, so no row exists at all — without
            // this create the run fails with zero steps and nothing names the
            // offending node. Only create when NO row exists for this key: a
            // timed-out adapter leaves a 'running' row the end-of-run sweep
            // closes, and a second row here would duplicate it.
            const existing = await tx.flowRunStep.count({ where: { flowRunId: run.id, nodeId: rowKey } })
            if (existing === 0) {
              await tx.flowRunStep.create({
                data: {
                  flowRunId: run.id,
                  nodeId: rowKey,
                  order: failedOrder,
                  status: 'failed',
                  input: jsonValue(outcome.input ?? {}),
                  output: jsonValue(outcome.output ?? null),
                  ...(outcome.items ? { items: jsonValue(outcome.items) } : {}),
                  error: outcome.error ? truncateWithMarker(outcome.error, 300) : null,
                  ...warningsPatch,
                  startedAt: outcome.startedAt,
                  finishedAt: outcome.finishedAt,
                },
              })
            }
          }).catch(() => undefined),
        )
      }
      // A retried 'agent' step that ends up pausing for human input: its row
      // is created/finished as 'waiting' by `runAgent` (one call per attempt,
      // unaware of the retry loop wrapping it), so the aggregate attempt
      // trail — only known here, after runAgentWithReliability returns — must
      // be patched on additively, same rule as succeeded/failed above. No-op
      // for every other emit shape (nothing else emits 'waiting' with
      // warnings today).
      if (outcome.status === 'waiting' && outcome.warnings?.length) {
        pending.push(
          prisma.flowRunStep
            .updateMany({
              where: { flowRunId: run.id, nodeId: rowKey, status: 'waiting' },
              data: { warnings: jsonValue(outcome.warnings) },
            })
            .catch(() => undefined),
        )
      }
      return
    }
    pending.push(
      prisma.flowRunStep
        .create({
          data: {
            flowRunId: run.id,
            nodeId: rowKey,
            order: ctx.nextOrder(),
            status: outcome.status,
            // The resolved input the node evaluated (see StepOutcome.input) —
            // `{}` only for outcomes that genuinely carry none (skips, stop).
            input: jsonValue(outcome.input ?? {}),
            output: jsonValue(outcome.output ?? null),
            ...(outcome.items ? { items: jsonValue(outcome.items) } : {}),
            error: outcome.error ? truncateWithMarker(outcome.error, 300) : null,
            ...(outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}),
            // Pin/override provenance for a node the interpreter never
            // actually ran (see interpret.ts's completedProvenance). Never
            // `warnings` — a pin/override substitution must not flip a clean
            // run `degraded`.
            ...(outcome.logs?.length ? { logs: jsonValue(outcome.logs) } : {}),
            startedAt: outcome.startedAt,
            finishedAt: outcome.finishedAt,
          },
        })
        .catch(() => undefined),
    )
  }

  return onStep
}
