import { CONDITION_OPS, type ConditionOp } from '@/lib/flows/graph'
import type { DataField } from '@/lib/flows/datatree'

/**
 * Which comparisons make sense for the value on the left of a condition.
 *
 * Every operator select in the builder offered all nineteen, whatever the field
 * held. Comparing a number, you were offered "starts with" and "is true";
 * comparing text, "is greater than" and "before". Most of those are not errors
 * the runtime will catch either — the evaluator is deliberately forgiving, so
 * `before` on a number falls back to comparing the two as strings and returns a
 * confident wrong answer rather than failing. The place to prevent that is the
 * list you pick from.
 *
 * Narrowing only. Nothing here changes how a stored condition evaluates, and an
 * operator already chosen is always offered (see `operatorsForField`) so an
 * existing flow keeps working and stays editable.
 */

const ALWAYS: readonly ConditionOp[] = ['exists', 'notExists']

const BY_TYPE: Record<string, readonly ConditionOp[]> = {
  // Dates arrive as strings in JSON, so before/after belong to the text set —
  // they are the only way to compare an ISO timestamp from a step's output.
  string: [
    'eq', 'neq',
    'contains', 'notContains', 'startsWith', 'endsWith', 'matches',
    'before', 'after',
    'isEmpty', 'isNotEmpty',
    ...ALWAYS,
  ],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', ...ALWAYS],
  boolean: ['isTrue', 'isFalse', 'eq', 'neq', ...ALWAYS],
  // A list or a record is checked for membership and emptiness, not ordered.
  array: ['contains', 'notContains', 'isEmpty', 'isNotEmpty', ...ALWAYS],
  object: ['isEmpty', 'isNotEmpty', ...ALWAYS],
}

/**
 * The operators worth offering for a field of this type.
 *
 * An unknown or absent type gets the full set: a value the builder cannot type
 * is one where the user knows more than we do, and guessing would take away
 * comparisons that are legitimately needed.
 */
export function operatorsForType(type: string | undefined): readonly ConditionOp[] {
  if (!type) return CONDITION_OPS
  return BY_TYPE[type] ?? CONDITION_OPS
}

/** Strip `{{ }}` from a token so it can be matched against the data tree. */
function bareToken(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('{{') && trimmed.endsWith('}}') ? trimmed.slice(2, -2).trim() : trimmed
}

/**
 * The declared type of the field a condition's left side points at, or
 * undefined when it points at something the data tree does not know: a literal,
 * a hand-typed path, or a mix of text and tokens.
 */
export function fieldTypeForToken(left: string | undefined, fields: readonly DataField[]): string | undefined {
  if (!left) return undefined
  const wanted = bareToken(left)
  if (!wanted) return undefined

  const walk = (nodes: readonly DataField[]): string | undefined => {
    for (const node of nodes) {
      if (bareToken(node.token) === wanted) return node.type
      const child = node.children && walk(node.children)
      if (child) return child
    }
    return undefined
  }
  return walk(fields)
}

/**
 * The operator list for one clause: narrowed to the left field's type, but
 * never dropping the operator the clause already uses.
 *
 * Hiding a stored choice would silently rewrite what the select displays and
 * leave no way back to it — the same rule the argument form follows for an
 * optional value that is already set.
 */
export function operatorsForField(
  left: string | undefined,
  fields: readonly DataField[],
  selected?: ConditionOp,
): readonly ConditionOp[] {
  const allowed = operatorsForType(fieldTypeForToken(left, fields))
  if (!selected || allowed.includes(selected)) return allowed
  return CONDITION_OPS.filter((op) => allowed.includes(op) || op === selected)
}
