import type { FlowGraph } from '@/lib/flows/graph'

/**
 * Undo/redo for the flow editor, as a pure reducer.
 *
 * This was two `useRef` stacks and four `useCallback`s in the middle of
 * `src/app/flows/[id]/page.tsx`, and it had no tests — refs are invisible to a
 * render-based test, and the rules it encodes are not obvious ones:
 *
 *  - a structural edit checkpoints, a burst of per-keystroke field edits
 *    checkpoints ONCE (so ⌘Z rolls back the whole edit, not one character);
 *  - any new edit invalidates redo, because the future it pointed at is no
 *    longer reachable;
 *  - history is capped, and the OLDEST entry is dropped — a cap that dropped
 *    the newest would silently make the most recent edit un-undoable;
 *  - loading a flow, adopting a co-editor's broadcast, and reverting to a
 *    version are all changes the user did not make here, so they must not
 *    become undo steps that would let ⌘Z resurrect someone else's discarded
 *    state.
 *
 * The reducer owns all of that. The only genuinely effectful part — the timer
 * that decides when a keystroke burst has ended — stays in the hook, which is
 * why `checkpoint` versus `replace` is the caller's choice rather than a flag
 * threaded through here.
 */

export interface GraphHistoryState {
  present: FlowGraph
  /** Most recent checkpoint last. */
  past: FlowGraph[]
  /** Next redo first. */
  future: FlowGraph[]
}

export type GraphHistoryAction =
  /** A structural edit: checkpoint the current graph, then move to `graph`. */
  | { type: 'checkpoint'; graph: FlowGraph }
  /** A change with no undo step of its own — a remote broadcast, a revert, a pin. */
  | { type: 'replace'; graph: FlowGraph }
  /** The same, expressed against the latest graph rather than a captured one. */
  | { type: 'apply'; update: (graph: FlowGraph) => FlowGraph }
  /**
   * Checkpoint, then edit — the first keystroke of a field-edit burst.
   *
   * Separate from `checkpoint` because the graph to preserve is the one BEFORE
   * this edit, and the only place it is reliably in hand is here, against the
   * current present. A caller that captured it itself would checkpoint whatever
   * the graph was when its callback was created.
   */
  | { type: 'checkpointApply'; update: (graph: FlowGraph) => FlowGraph }
  /** A freshly loaded flow: nothing before it is undoable. */
  | { type: 'reset'; graph: FlowGraph }
  | { type: 'undo' }
  | { type: 'redo' }

/**
 * How many edits back ⌘Z reaches. Bounded because each entry is a whole graph;
 * an unbounded stack on a large flow is a memory leak that grows with use.
 */
export const HISTORY_LIMIT = 50

export function initialGraphHistory(graph: FlowGraph): GraphHistoryState {
  return { present: graph, past: [], future: [] }
}

/** Append, dropping the OLDEST entry once the cap is reached. */
function pushCapped(stack: FlowGraph[], graph: FlowGraph): FlowGraph[] {
  const next = [...stack, graph]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

export function graphHistoryReducer(
  state: GraphHistoryState,
  action: GraphHistoryAction,
): GraphHistoryState {
  switch (action.type) {
    case 'checkpoint': {
      // A no-op edit must not consume an undo slot: with a 50-entry cap, fifty
      // of them would push every real checkpoint out of reach.
      if (action.graph === state.present) return state
      return { present: action.graph, past: pushCapped(state.past, state.present), future: [] }
    }
    case 'replace': {
      if (action.graph === state.present) return state
      return { ...state, present: action.graph }
    }
    case 'apply': {
      const next = action.update(state.present)
      if (next === state.present) return state
      return { ...state, present: next }
    }
    case 'checkpointApply': {
      const next = action.update(state.present)
      if (next === state.present) return state
      return { present: next, past: pushCapped(state.past, state.present), future: [] }
    }
    case 'reset':
      return initialGraphHistory(action.graph)
    case 'undo': {
      if (!state.past.length) return state
      return {
        present: state.past[state.past.length - 1],
        past: state.past.slice(0, -1),
        future: [state.present, ...state.future],
      }
    }
    case 'redo': {
      if (!state.future.length) return state
      return {
        present: state.future[0],
        past: pushCapped(state.past, state.present),
        future: state.future.slice(1),
      }
    }
  }
}

export const canUndo = (state: GraphHistoryState): boolean => state.past.length > 0
export const canRedo = (state: GraphHistoryState): boolean => state.future.length > 0
