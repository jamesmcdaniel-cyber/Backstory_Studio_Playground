# Flow Canvas Builder — DAG Phase 2

Date: 2026-07-28
Status: Design (approved)
Scope: Phase 2 of the DAG work begun in
`2026-07-14-dag-flow-engine-design.md`. Phase 1 shipped the headless DAG
execution engine. This spec covers the authoring surface: an n8n-style canvas
where nodes are freely positioned, edges are drawn by hand, and one node can
fan out to several downstream paths that run concurrently.

## Goal

Make the DAG the engine already executes *drawable*. Today the builder renders a
single vertical chain: one node in, one node out, branches nested as boxes. A
user cannot connect two nodes into one, cannot fan one node out to two paths,
and every step is a tall inline-editing card that makes a ten-step flow a long
scroll.

After this change the builder has two tabs — **Inline** (today's chain, kept)
and **Canvas** (new) — and on Canvas a step is a compact ~200×64 chip with
handles, positioned freely, connected by dragging.

## What already exists (no work needed)

The engine is done. `src/lib/flows/dag-scheduler.ts` implements fan-out
(`ok` activates every non-error out-edge), fan-in with dead-path elimination
(OR-join), and cycle detection. `src/lib/flows/validate.ts` already accepts
multiple incoming edges and reports `CYCLE`. `join` merges multi-parent input.

The persistence is done. `flowNodeSchema` carries an optional `position`;
`flowEdgeSchema` carries an optional `branch`. **No schema or database change is
in scope.**

The layout is done. `src/lib/flows/layout.ts` computes a dagre left-to-right
layout at a 200×64 node footprint, written against React Flow's top-left origin
convention, honoring already-persisted positions.

The mutations are half done. `src/lib/flows/mutate.ts` exports `addEdge`,
`removeEdge` and `setNodePositions` — all currently unused by the UI.

`@xyflow/react` 12.11.2 (MIT) is already a dependency and imported nowhere.

## Approach

Build on React Flow (`@xyflow/react`) rather than hand-rolling a canvas.

- It is already installed, and `layout.ts` was written against its coordinate
  convention.
- It supplies all four requested v1 features directly: minimap, marquee
  selection, handle-drag connection, viewport transform.
- The alternatives — a hand-rolled SVG canvas, or extending the existing
  CSS-transform pan in `use-canvas-pan.ts` — both mean re-implementing edge
  routing, handles, marquee select and a minimap by hand for a worse result.

React 18.2 satisfies its peer range. Its stylesheet (`@xyflow/react/dist/style.css`)
is imported once by the canvas component. `colorMode` is bound to the app theme
so dark mode works.

## Decisions taken

| Question | Decision |
|---|---|
| Canvas replaces Inline, or both? | Both. Two tabs: **Inline** and **Canvas**. |
| How much does a canvas node show? | Compact chip only — icon, name, status dot, issue badge. All editing in the existing `StepDrawer`. |
| Loop / parallel containers? | One opaque node with a step-count badge; body edited as a list in the drawer, exactly as the engine and `layout.ts` already model it. |
| v1 interactions | Pan/zoom, drag-to-position, handle-drag connect, edge delete, double-click to open drawer, `+` insert stub, **plus** minimap, auto-layout, box-select + bulk ops, and copy/paste. |
| Multiplayer on canvas | Full parity — cursors and remote editing rings both work. |

## Architecture

### New files

| File | Purpose |
|---|---|
| `src/lib/flows/canvas-model.ts` | Pure `FlowGraph ↔ React Flow {nodes, edges}` mapping: handle derivation, branch labels, contained-node exclusion, `isLinearRenderable`. No React imports. |
| `src/lib/flows/node-presentation.ts` | `titleFor` / `subtitleFor` / icon, lifted out of `flow-canvas.tsx` so Inline and Canvas share one label source. |
| `src/components/flows/canvas/graph-canvas.tsx` | The React Flow surface: viewport, minimap, controls, connect / select / drag handlers. |
| `src/components/flows/canvas/step-node.tsx` | The compact chip: icon tile, name, status dot, issue badge, handles, remote-editing ring. |
| `src/components/flows/canvas/step-edge.tsx` | Edge with hover-delete, branch label, and a `+` insert button at its midpoint. |

`node-presentation.ts` is a pure extraction: `flow-canvas.tsx` imports the
functions back rather than keeping its own copies, so the two tabs can never
drift on what a step is called.

### Modified files

- `src/app/flows/[id]/page.tsx` — Inline/Canvas tab state, persisted to
  `localStorage`. The drawer, copilot, test, run, checker and versions panels
  are shared unchanged by both tabs. Keyboard handlers gain canvas-aware
  copy/paste.
- `src/lib/flows/mutate.ts` — position-aware siblings of the existing ops:
  `insertNodeAt(graph, type, position, agentId?)`,
  `pasteNodesAt(graph, payload, position)`, and `connect(graph, source, target,
  branch?)` wrapping `addEdge` with validation. `removeEdge` and
  `setNodePositions` are used as-is.
- `src/lib/flows/layout.ts` — add `layoutGraph(graph, { force?: boolean })`.
  With `force`, persisted positions are ignored (this is "Tidy up"); the
  default behavior is unchanged.
- `src/lib/flows/cursor-space.ts` — add a flow-space path alongside the
  existing content-space one; Inline keeps using the latter.
- `src/lib/flows/clipboard.ts` — multi-node clipboard (below).
- `src/components/flows/canvas-rail.tsx` — zoom/fit/jump callbacks become
  injectable so the rail can drive either the scroll container (Inline) or the
  React Flow viewport (Canvas).

### Data model

Unchanged. The canvas reads and writes exactly the `FlowGraph` shape that
exists today.

Every mutation routes through the page's existing `commitGraph`, so undo/redo
and the jam broadcast (`diffGraph` → `GraphOps` → `applyGraphOps`) work with no
changes to either.

### Handles

This is what makes fan-out drawable.

- every node: one target handle (left), one source handle (right), id `out`
- `condition`: two source handles — `true`, `false`
- `switch`: one source handle per case id, plus `default`
- `agent` / `tool` / `http` with `onError: 'route'`: an additional amber
  `error` source handle
- `trigger`: no target handle
- `stop`: no source handle

An edge maps as `sourceHandle = edge.branch ?? 'out'`. Fan-out is therefore just
dragging a second edge off the same handle — the scheduler's `ok` result already
activates every non-error out-edge, so both paths run concurrently with no
engine change.

### Connection validation

Enforced in `isValidConnection` so an illegal edge cannot be drawn at all,
rather than being drawn and failing validation later. Rejected:

- self-edges
- duplicates (`addEdge` already reports `added: false`)
- any edge whose source or target is inside a loop/parallel body
- any edge that would create a cycle — reusing `findCycle` from
  `dag-scheduler.ts` against the prospective graph

Legal fan-out (two edges off one handle) and legal fan-in (two edges into one
target) are accepted.

### Legacy positions

Flows authored before this have no `position`. On first Canvas open,
`layoutGraph` computes positions in memory and they are **not** committed —
otherwise merely opening a flow would dirty its draft and create a version.
Positions persist only on drag, paste, node creation, or Tidy up.

## Interaction spec

### Adding a step

Three entry points, all reusing the existing `FlowPicker`:

1. `+` at an edge's midpoint — inserts between those two nodes, splicing the
   edge into two.
2. `+` stub on a node's unconnected source handle — appends downstream.
3. Drag from a source handle and release on empty canvas — the picker opens at
   the drop point; the new node lands there with the edge pre-made.

For (1) and (2) the new node is positioned by offsetting right of its source,
then nudged down while that rectangle overlaps an existing node, so new steps
never stack.

### Selecting and editing

- single click selects (drawer stays closed), matching today's `setSelectedId`
- double click opens the `StepDrawer`, unchanged
- `⌘/Ctrl+click` and marquee drag extend `selectedIds`, which already drives the
  bulk duplicate/delete toolbar in `page.tsx`
- the existing `d`-to-disable and Delete-to-remove keyboard shortcuts work on
  the canvas selection

### Connecting and disconnecting

Drag handle to handle to connect. Hovering an edge reveals a delete affordance;
selecting an edge and pressing Delete removes it. `reconnectEdge` allows
dragging an existing edge's endpoint onto a different node.

### Copy and paste

Today's clipboard holds exactly one node. Canvas needs a subgraph, so
`flows.clipboard.v2` holds `{ nodes: FlowNode[], edges: FlowEdge[] }`:

- edges *internal* to the selection are preserved; edges crossing the selection
  boundary are dropped
- v1 (single-node) payloads remain readable, so an in-flight clipboard from a
  previous session still pastes
- paste lands at the pointer, with ids remapped and positions offset as a group
- the `trigger` is never copyable

### Tidy up, minimap, rail

"Tidy up" calls `layoutGraph(graph, { force: true })` → `setNodePositions` →
`commitGraph`, so it is a single undo step.

The minimap is React Flow's, with node color derived from run status.

`CanvasRail` is kept on **both** tabs. On Canvas its zoom/fit buttons bind to
React Flow's `zoomIn` / `zoomOut` / `fitView`, and its step search jumps via
`fitView({ nodes: [{ id }] })` instead of `scrollIntoView`.

### Run status and issues

`statusByNode` drives the node's border and status dot — idle, running (pulse),
succeeded, failed, skipped. `issuesByNode` drives the error/warning badge,
keeping the existing popover behavior.

Edges carry state too: an edge the scheduler activated renders solid and
animated during a live run; a dead branch renders dimmed. This is the payoff of
the canvas — on a fan-out both paths visibly light up at once.

### Multiplayer parity

The cursor layer moves inside React Flow's `<ViewportPortal>` so it transforms
with pan and zoom automatically. `sendCursor` converts pointer coordinates via
`screenToFlowPosition` instead of `toContentSpace`.

Flow coordinates are the same space `position` is stored in, so a cursor parked
on a node appears on that node for every viewer regardless of their own pan and
zoom — the same guarantee the content-space implementation gives today.

Remote selection rings pass through node data into `StepNode`, rendering the
same colored ring and name chip as the Inline card.

### Inline tab degradation

The Inline chain walker cannot express fan-out. Rather than silently hiding
steps, `canvas-model.ts` exports `isLinearRenderable(graph)`. When it returns
false the Inline tab:

- shows a banner: "This flow has parallel paths — open it in Canvas to see them"
- renders every node the chain walk never reached in an "Also in this flow"
  list at the bottom, each clickable to open its drawer

Nothing becomes invisible or uneditable on the Inline tab.

## Testing

Pure logic first, since that is where the risk concentrates.

- **`canvas-model`**: graph → nodes/edges mapping; handle derivation for
  condition, switch, error-routing, trigger and stop; contained nodes excluded;
  `isLinearRenderable` true for a chain and false for a diamond.
- **Connection validation**: self-edge, duplicate, cycle and contained-node edge
  all rejected; a legal fan-out and a legal fan-in both accepted.
- **`layoutGraph({ force })`**: overrides persisted positions; the default still
  honors them.
- **Multi-node clipboard**: internal edges kept, boundary edges dropped, ids
  remapped, v1 payload still readable.
- **Position-aware insert and paste**: no coordinate collisions with existing
  nodes.
- **RTL smoke tests**: `StepNode` renders title, status and issue badge and
  exposes the correct handles per node type; the Inline degradation banner
  appears for a fan-out graph and lists the unreached nodes.

Regression gates, both of which must stay green with no edits:

- `src/components/flows/__tests__/node-parity.test.tsx`
- `src/features/flows/__tests__/interpret.test.ts`

## Non-goals

- No engine change and no schema change.
- Loop and parallel internals unchanged — no group-frame rendering of container
  bodies on canvas.
- No back-edges; cycles remain a `CYCLE` validation error, and retry stays the
  `retries` field.
- `StepCard` and its inline editors are untouched; they continue to serve the
  Inline tab.
- No change to the copilot's graph generation beyond what it already emits.
