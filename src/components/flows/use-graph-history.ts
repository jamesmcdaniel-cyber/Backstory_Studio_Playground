'use client'

import { useCallback, useMemo, useReducer, useRef } from 'react'
import {
  canRedo,
  canUndo,
  graphHistoryReducer,
  initialGraphHistory,
} from '@/lib/flows/graph-history'
import { updateNode } from '@/lib/flows/mutate'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * How long a run of per-keystroke field edits counts as ONE edit.
 *
 * Typing into a step's field fires a change per character. Checkpointing each
 * one makes ⌘Z undo a single character; checkpointing none makes it undo the
 * whole session. The burst window is the middle: the first keystroke
 * checkpoints, the rest ride along, and the burst closes once typing pauses.
 */
const FIELD_EDIT_BURST_MS = 600

export interface GraphHistoryHandle {
  graph: FlowGraph
  /** A structural edit — becomes one undo step. */
  commitGraph: (next: FlowGraph) => void
  /** A per-keystroke field edit — the whole burst becomes one undo step. */
  commitFieldEdit: (node: FlowNode) => void
  /** A change the user did not make here: a remote broadcast, a revert, a pin. */
  replaceGraph: (next: FlowGraph) => void
  /** The same, computed against the latest graph. */
  applyToGraph: (update: (graph: FlowGraph) => FlowGraph) => void
  /** A freshly loaded flow: nothing before it is undoable. */
  resetGraph: (next: FlowGraph) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

/**
 * The flow editor's graph, with undo/redo.
 *
 * The rules live in the pure reducer (src/lib/flows/graph-history.ts) where
 * they can be tested. All this adds is the one genuinely effectful part: the
 * timer that decides when a keystroke burst has ended.
 */
export function useGraphHistory(initial: FlowGraph): GraphHistoryHandle {
  const [state, dispatch] = useReducer(graphHistoryReducer, initial, initialGraphHistory)
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commitGraph = useCallback((next: FlowGraph) => {
    dispatch({ type: 'checkpoint', graph: next })
  }, [])

  const commitFieldEdit = useCallback((node: FlowNode) => {
    // Only the FIRST edit of a burst checkpoints; the rest replace. Both go
    // through `apply` semantics so the update sees the latest graph rather than
    // one captured when the callback was created.
    const opening = burstTimer.current === null
    if (burstTimer.current) clearTimeout(burstTimer.current)
    burstTimer.current = setTimeout(() => {
      burstTimer.current = null
    }, FIELD_EDIT_BURST_MS)
    dispatch({
      type: opening ? 'checkpointApply' : 'apply',
      update: (graph) => updateNode(graph, node),
    })
  }, [])

  const replaceGraph = useCallback((next: FlowGraph) => {
    dispatch({ type: 'replace', graph: next })
  }, [])
  const applyToGraph = useCallback((update: (graph: FlowGraph) => FlowGraph) => {
    dispatch({ type: 'apply', update })
  }, [])
  const resetGraph = useCallback((next: FlowGraph) => {
    dispatch({ type: 'reset', graph: next })
  }, [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  return useMemo(
    () => ({
      graph: state.present,
      commitGraph,
      commitFieldEdit,
      replaceGraph,
      applyToGraph,
      resetGraph,
      undo,
      redo,
      canUndo: canUndo(state),
      canRedo: canRedo(state),
    }),
    [state, commitGraph, commitFieldEdit, replaceGraph, applyToGraph, resetGraph, undo, redo],
  )
}

