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
 */
export type FlowQueueDecision = { jobId?: string; attempts?: number }

export function flowJobOptions(flowRunId: string | undefined, preparedRunId?: string, deliveryId?: string, now: number = Date.now()): FlowQueueDecision {
  if (flowRunId) return { jobId: `${flowRunId}-resume-${now}` }
  if (preparedRunId) return { jobId: `${preparedRunId}-start`, attempts: 1 }
  if (deliveryId) return { jobId: `delivery-${deliveryId}`, attempts: 1 }
  return { attempts: 1 }
}
