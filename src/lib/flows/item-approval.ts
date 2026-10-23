/**
 * Per-item approvals: a step that needs sign-off inside a per-item container
 * (a loop body, or a step marked "run once per item") asks once PER ITEM, and
 * only that item waits.
 *
 * The model, end to end:
 *  - Each item's step creates its own ApprovalRequest, labelled with the item
 *    (payload.item), and pauses only that item. Items that need no approval —
 *    and items whose approval is already decided — run on.
 *  - The run stays `waiting` while ANY of its approvals is undecided. Deciding
 *    one does not resume the run (decideApproval holds the resume back); the
 *    LAST decision does, and the resume reads every decision from the approval
 *    rows themselves, not from the reply that triggered it.
 *  - On that resume an approved item continues with the write's result (which
 *    decideApproval already executed, exactly once); a rejected item is
 *    skipped — dropped from the container's output and recorded on its step
 *    row and as a warning — and other items are unaffected.
 *  - A resume that arrives while some approvals are still pending (a worker
 *    restart, a duplicate delivery) re-attaches each waiting item to its SAME
 *    approval instead of queueing a new one, so it is idempotent.
 *
 * Pure helpers only — no DB — so the interpreter, the action executor, the
 * approvals API and their tests share one definition.
 */

export type ApprovalItem = {
  /** 0-based position in the container's list. */
  index: number
  /** How many items the container iterated. */
  count: number
  /** A short human label for the item ("Acme Corp", "ada@example.com"). */
  label: string
}

/** Field names that usually name a record, in the order people expect. */
const LABEL_KEYS = ['name', 'title', 'label', 'subject', 'email', 'company', 'account', 'displayName', 'id', 'key']

const MAX_LABEL = 80

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_LABEL ? `${collapsed.slice(0, MAX_LABEL - 1)}…` : collapsed
}

/** The best short label for an item value; '' when nothing readable is in it. */
export function itemLabel(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return clip(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.length ? `${value.length} item${value.length === 1 ? '' : 's'}` : ''
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of LABEL_KEYS) {
      const candidate = record[key]
      if ((typeof candidate === 'string' && candidate.trim()) || typeof candidate === 'number') return clip(String(candidate))
    }
    // A record with a first/last name pair.
    const first = typeof record.firstName === 'string' ? record.firstName : ''
    const last = typeof record.lastName === 'string' ? record.lastName : ''
    if (first || last) return clip(`${first} ${last}`)
  }
  return ''
}

export function approvalItem(index: number, count: number, value: unknown): ApprovalItem {
  return { index, count, label: itemLabel(value) }
}

/** "item 2 of 3 · Acme Corp" — how an approval names its item everywhere. */
export function describeApprovalItem(item: ApprovalItem): string {
  const position = `item ${item.index + 1} of ${item.count}`
  return item.label ? `${position} · ${item.label}` : position
}

/** Read an item back off a stored approval payload (or a waiting step's output). */
export function approvalItemOf(value: unknown): ApprovalItem | null {
  const item = (value as { item?: unknown } | null | undefined)?.item as Partial<ApprovalItem> | undefined
  if (!item || typeof item !== 'object') return null
  if (typeof item.index !== 'number' || typeof item.count !== 'number') return null
  return { index: item.index, count: item.count, label: typeof item.label === 'string' ? item.label : '' }
}

/** The step output recorded for an item whose approval was rejected. */
export type RejectedItemOutput = {
  skipped: 'approval_rejected'
  approvalId: string
  item: ApprovalItem
  message: string
}

export function rejectedItemOutput(approvalId: string, item: ApprovalItem): RejectedItemOutput {
  return {
    skipped: 'approval_rejected',
    approvalId,
    item,
    message: `The approver rejected ${describeApprovalItem(item)}, so it was skipped.`,
  }
}

/** Is this a recorded rejection? A replay must drop the item again, never revive it. */
export function isRejectedItemOutput(value: unknown): value is RejectedItemOutput {
  const record = value as Partial<RejectedItemOutput> | null
  return Boolean(record && typeof record === 'object' && record.skipped === 'approval_rejected' && typeof record.approvalId === 'string')
}

/** The container-level warning: how many items an approver turned down. */
export function rejectedItemsWarning(rejected: number, total: number): string | undefined {
  if (!rejected) return undefined
  return `${rejected} of ${total} item${total === 1 ? '' : 's'} ${rejected === 1 ? 'was' : 'were'} rejected by an approver and skipped.`
}
