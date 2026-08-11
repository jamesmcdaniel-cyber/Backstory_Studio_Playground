/**
 * BullMQ job options for a queued flow execution (see execute-flow.ts's
 * dispatchFlowExecution). Resume jobs get a jobId derived from the run —
 * redelivery/retry of the SAME job is safe because runFlowExecution's atomic
 * claim (Task 1 of WS-R2) makes a second attempt a harmless no-op. Prepared
 * jobs (row created up front by startFlowExecution) get a stable jobId so a
 * double dispatch of the same run dedupes in the queue, and attempts:1 —
 * runFlowExecution refuses a prepared run that already left `running`, but a
 * retry racing the first attempt could still double side effects. Fresh
 * executions get attempts:1 — there is no pre-existing row a retry could
 * safely resume against, so a retry would duplicate the whole run.
 *
 * WHY attempts:1 SURVIVES THE SIDE-EFFECT LEDGER (2026-08-11). The ledger
 * (src/lib/flows/side-effect-ledger.ts) makes a replayed write a no-op, which
 * looks like it should unblock attempts:2 for prepared jobs — their run id, and
 * therefore their ledger keys, are stable across attempts. It does not, because
 * the ledger is itself read-then-act: readLedger -> execute -> writeLedger. Two
 * CONCURRENT attempts both miss the read, both fire the write, and the unique
 * constraint only decides which one records the result. It serializes
 * sequential replay, not concurrency — and stall recovery, where BullMQ
 * declares a job stalled while the process is still alive, is exactly the
 * concurrent case.
 *
 * Making a retry genuinely safe needs a claim row written BEFORE execution so
 * attempts serialize, plus a reaper for claims left by a crashed attempt
 * (otherwise a crash blocks the legitimate retry forever). That is a real
 * design, not a flag flip. Until then: attempts:1, and worker crashes are
 * recovered by reapStuckFlowRuns marking the run failed.
 */
export type FlowQueueDecision = { jobId?: string; attempts?: number }

export function flowJobOptions(flowRunId: string | undefined, preparedRunId?: string, deliveryId?: string, now: number = Date.now()): FlowQueueDecision {
  if (flowRunId) return { jobId: `${flowRunId}-resume-${now}` }
  if (preparedRunId) return { jobId: `${preparedRunId}-start`, attempts: 1 }
  if (deliveryId) return { jobId: `delivery-${deliveryId}`, attempts: 1 }
  return { attempts: 1 }
}
