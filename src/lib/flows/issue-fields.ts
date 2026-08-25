import type { FlowValidationIssue } from '@/lib/flows/validate'

/**
 * Which control in the step's config panel an issue belongs to.
 *
 * The checker already says WHAT is wrong and which step it is wrong on, and
 * clicking a finding opens that step. What it could not say is WHICH FIELD:
 * the panel showed one banner of messages at the top, and matching "Tool call
 * needs a connection" to the right select was left to the reader. On a step
 * with a dozen controls that is a hunt, and the hunt gets worse the more
 * configurable a step becomes.
 *
 * Derived from the issue CODE rather than carried on the issue itself, so
 * validate.ts stays a pure description of what is wrong and the panel owns
 * where that lives on screen — the same code can be raised from several places
 * and still lands on one control. A code with no entry keeps the old
 * behaviour: it shows in the step-level banner and nowhere else, which is the
 * right answer for graph-shaped findings (cycles, unreachable steps) that
 * belong to no single field.
 *
 * Keys are the panel's own field names, registered next to the control they
 * mark (see FIELD_* in step-drawer.tsx).
 */
export const FIELD_BY_CODE: Record<string, string> = {
  // Agent
  MISSING_AGENT: 'agentId',
  UNKNOWN_AGENT: 'agentId',
  EMPTY_AGENT_INPUT: 'input',
  TEXT_AGENT_FIELD_REF: 'input',
  AGENT_TOOL_CONNECTION_UNAVAILABLE: 'agentId',
  UNKNOWN_AGENT_TOOL_CONNECTION: 'agentId',

  // HTTP request
  MISSING_HTTP_URL: 'url',
  INVALID_HTTP_URL: 'url',
  HTTP_NO_AUTH: 'httpAuth',
  AMBIGUOUS_HTTP_AUTH: 'httpAuth',
  INVALID_HTTP_AUTH_CONNECTION: 'httpAuth',
  UNKNOWN_HTTP_CONNECTION: 'httpAuth',
  UNKNOWN_HTTP_CREDENTIAL: 'httpAuth',
  HTTP_BODY_IGNORED: 'httpBody',
  FILE_FIELD_BODY_OFF: 'httpBody',
  FILE_FIELD_NEEDS_FORM_DATA: 'httpBody',
  FILE_FIELD_NO_BODY_METHOD: 'httpBody',
  FILE_FIELD_NO_NAME: 'httpBody',
  FILE_FIELD_NO_SOURCE: 'httpBody',
  FILE_FIELD_BAD_SOURCE: 'httpBody',
  FILE_FIELD_DUPLICATE: 'httpBody',
  FILE_FIELD_UNKNOWN_STEP: 'httpBody',

  // Tool call
  MISSING_TOOL_CONNECTION: 'connectionId',
  UNKNOWN_TOOL_CONNECTION: 'connectionId',
  TOOL_CONNECTION_UNAVAILABLE: 'connectionId',
  MISSING_TOOL: 'toolName',
  UNKNOWN_TOOL: 'toolName',
  MISSING_TOOL_ARG: 'toolArgs',
  PER_ITEM_STATIC_ARGS: 'toolArgs',
  SQL_TOKEN_IN_LITERAL: 'toolArgs',

  // Code
  EMPTY_CODE: 'code',

  // Subflow
  SUBFLOW_NO_FLOW: 'flowId',
  SUBFLOW_SELF: 'flowId',

  // AI operation
  AI_EMPTY_INPUT: 'aiInput',
  AI_EXTRACT_NO_FIELDS: 'aiFields',
  AI_CATEGORIZE_TOO_FEW: 'aiFields',
  AI_SCORE_BAD_RANGE: 'aiFields',

  // Knowledge
  KNOWLEDGE_EMPTY_QUERY: 'query',

  // Branching
  EMPTY_CONDITION: 'clauses',
  MISSING_CONDITION_LEFT: 'clauses',
  EMPTY_SWITCH: 'cases',
  MISSING_SWITCH_LEFT: 'cases',
  MISSING_SWITCH_CASE_ID: 'cases',
  DUPLICATE_SWITCH_CASE: 'cases',
  MISSING_SWITCH_DEFAULT: 'cases',

  // Set fields / data operations
  EMPTY_TRANSFORM: 'fields',
  MISSING_TRANSFORM_FIELD: 'fields',
  DUPLICATE_TRANSFORM_FIELD: 'fields',
  EMPTY_DATA_FIELDS: 'fields',
  MISSING_DATA_FIELD_NAME: 'fields',
  EMPTY_DATA_CLAUSES: 'clauses',
  MISSING_DATA_CLAUSE_LEFT: 'clauses',
  MISSING_DATA_INPUT: 'dataInput',
  MERGE_NO_KEY: 'dataInput',

  // Variable
  MISSING_VARIABLE_NAME: 'variableName',
  DUPLICATE_VARIABLE: 'variableName',
  MISSING_VARIABLE_VALUE: 'variableValue',
  VARIABLE_NOT_NUMERIC: 'variableValue',

  // Output
  MISSING_OUTPUT_NAME: 'outputFields',
  DUPLICATE_OUTPUT_NAME: 'outputFields',
  EMPTY_OUTPUT_VALUE: 'outputFields',
  EMPTY_OUTPUT: 'outputFields',
  LIST_INTO_SINGLE: 'outputFields',

  // Request information
  MISSING_REVIEW_MESSAGE: 'reviewMessage',
  MISSING_INPUT_FIELD_NAME: 'inputFields',
  DUPLICATE_INPUT_FIELD: 'inputFields',
  INVALID_INPUT_FIELDS: 'inputFields',
  INVALID_INPUT_FIELD_TYPE: 'inputFields',

  // Loop / per-item
  MISSING_LOOP_SOURCE: 'loopSource',
  MISSING_PERITEM_SOURCE: 'perItem',

  // Wait
  MISSING_WAIT_AMOUNT: 'wait',
  MISSING_WAIT_UNTIL: 'wait',

  // Trigger
  INVALID_TRIGGER_TYPE: 'trigger',
  INVALID_TRIGGER_CONFIG: 'trigger',
  MISSING_CRON: 'trigger',
  MISSING_SCHEDULE: 'trigger',
  MISSING_SCHEDULE_DATE: 'trigger',
  MISSING_SCHEDULE_TIME: 'trigger',
  MISSING_SIGNAL: 'trigger',
  MISSING_ACTIVITY_CONFIG: 'trigger',
  MISSING_POLL_CONNECTION: 'trigger',
  MISSING_POLL_TOOL: 'trigger',
  MISSING_POLL_SCHEDULE: 'trigger',
  MISSING_WEBHOOK_SECRET: 'trigger',
  MISSING_SLACK_WORKSPACE: 'trigger',
  EVENT_TRIGGER_NOT_ENTITLED: 'trigger',
}

/** The panel field an issue marks, or undefined when it belongs to no one control. */
export function issueFieldKey(issue: { code?: string }): string | undefined {
  return issue.code ? FIELD_BY_CODE[issue.code] : undefined
}

export type FieldIssue = Pick<FlowValidationIssue, 'level' | 'message'> & { code?: string }

/**
 * Split a step's issues into the ones a control owns and the ones left over.
 *
 * The leftovers still need the step-level banner — an issue that quietly
 * vanished because nothing claimed its code would be worse than the hunt this
 * replaces.
 */
export function splitIssuesByField(issues: readonly FieldIssue[] | undefined): {
  byField: Map<string, FieldIssue[]>
  rest: FieldIssue[]
} {
  const byField = new Map<string, FieldIssue[]>()
  const rest: FieldIssue[] = []
  for (const issue of issues ?? []) {
    const field = issueFieldKey(issue)
    if (!field) {
      rest.push(issue)
      continue
    }
    const bucket = byField.get(field)
    if (bucket) bucket.push(issue)
    else byField.set(field, [issue])
  }
  return { byField, rest }
}
