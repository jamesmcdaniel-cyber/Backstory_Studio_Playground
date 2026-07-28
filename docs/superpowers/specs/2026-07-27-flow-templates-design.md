# Flow Templates — design

Date: 2026-07-27

## Problem

Agent templates are a first-class product surface: a gallery at `/templates`, ~40
hand-authored built-ins, org-scoped and community-published rows in
`AgentTemplate`, detail pages, AI-search, and an AI generation engine that
proposes new ones from real integration usage.

Flows have none of that. The entire flow-template story today is three hardcoded
entries in `src/lib/flows/starter-templates.ts`, surfaced only as a dropdown on
the Flows page. They deliberately use "connection-free node types (ai / data /
condition / wait / output)" so they instantiate cleanly anywhere — which also
means they demonstrate almost nothing of what the flow engine can actually do.

A flow template should be able to ship the sophisticated thing: a pipeline that
paginates a CRM, scores every account per-item, filters, joins, ranks in a code
node, and publishes. That is the reason to open the tab.

## What makes a flow template different from an agent template

An agent template's payload is one prose blob (`instructions`) that becomes the
agent's objective. The model reads it and decides what to do.

A flow template's payload is a **wired graph** — typed nodes with real
configuration (per-item fan-out, pagination, retry envelopes, branch conditions,
code bodies). Nothing about that is expressible as prose the runtime reads. So
"instructions" for a flow template means something structurally different: the
graph is the executable artifact, and the instructions are the *explanation*
anchored to it — per-node and per-template.

## Design

### 1. Data model

New `FlowTemplate` model, mirroring `AgentTemplate`'s org/visibility/source
conventions but with the flow-specific payload as first-class columns:

```prisma
model FlowTemplate {
  id             String   @id @default(cuid())
  name           String
  description    String?  @db.Text
  category       String   @default("Custom")
  graph          Json                  // the wired FlowGraph
  trigger        Json     @default("{}")
  notes          Json?                 // FlowTemplateNotes (§2)
  bindings       Json     @default("[]") // FlowTemplateBinding[] (§3)
  configuration  Json?                 // integrations, tags, icon, exampleOutput, authorName
  isActive       Boolean  @default(true)
  source         String   @default("user")   // user | ai_generated
  visibility     String   @default("org")    // org | global
  userId         String
  organizationId String   @db.Uuid
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, isActive])
  @@index([organizationId, visibility])
  @@map("flow_templates")
}
```

Rejected: a `kind` discriminator on `AgentTemplate`. The row shape genuinely
diverges (no `model` / `skills` / `allowSubagents`; a graph and a trigger
instead of a prompt), and every existing agent-template query would need a
filter added — a silent cross-contamination risk for a table that already backs
the community catalogue.

### 2. Instructions — two layers

**Layer A — per-node notes that ship into the user's flow.** Every executable
node type in `flowNodeSchema` already declares `data.note`. Built-in templates
populate it. "Paginates 200 accounts per page and drops anything closed-lost"
renders *on the node* in the builder, so the explanation survives instantiation
instead of living only as gallery copy.

**Layer B — a template-level notes object**, for the detail page, the
save-as-template drafting path, and copilot grounding:

```ts
export type FlowTemplateNotes = {
  /** What this pipeline achieves, and how you know it worked. */
  objective: string
  /** What you supply at run time. */
  inputs: { name: string; description: string; example?: string }[]
  /** One entry per executable node, keyed to a real graph node id. */
  steps: { nodeId: string; title: string; what: string; why?: string }[]
  /** Thresholds and branch logic in plain English. */
  decisionRules?: string
  /** Retries, partial failure, deduplication, idempotency. */
  failureHandling?: string
  /** Ordered "before this runs" checklist. */
  setup: { label: string; kind: 'integration' | 'agent' | 'value'; ref?: string }[]
  /** The knobs worth tuning for your workspace. */
  customize?: string[]
  /** How to verify it before switching the trigger on. */
  testPlan?: string
}
```

Per the standing no-raw-token rule, **no `{{ }}` may appear in any notes
string**. Steps reference each other by title ("the accounts from *Pull
accounts*"), matching how the builder renders chips. A test asserts this over
the whole built-in catalog.

Structural invariants, enforced by test:
- every `steps[].nodeId` exists in `graph.nodes`
- every executable node (not `trigger`, not `note`) has a `steps` entry
- every executable node has a non-empty `data.note`

### 3. Bindings

A sophisticated template references things a target workspace may not have: a
specific agent, a Nango connection, an MCP tool. `agentNode.data.agentId` and
`toolNode.data.connectionId` are required strings in the schema, so the template
ships them empty and declares how to fill them:

```ts
export type FlowTemplateBinding = {
  nodeId: string
  kind: 'agent' | 'connection'
  /** Plain-English "what goes here", shown in the setup checklist. */
  label: string
  /** How to find it in the target workspace. */
  match: { agentName?: string; provider?: string; toolName?: string }
}
```

Binding hints live at the template level, not inside `data` — zod strips unknown
keys from the node data objects, so the graph stays schema-pure.

### 4. Instantiate — "Use this flow"

`instantiateFlowTemplate(organizationId, userId, template)`:

1. Clone the graph; rewrite every node id to a fresh one (and the matching edge
   endpoints, `parallel.branches`, and any `perItem` references) so two
   instantiations never collide.
2. Resolve each binding against the workspace: agents matched by name, tool
   connections matched by provider (+ tool name where given). Matched → write
   the real id into the node. Unmatched → leave empty; the node keeps its
   `label` so it still reads sensibly on the canvas.
3. Run `validateFlowGraph`.
4. Create the Flow as **DRAFT** — never active on arrival — with the trigger
   derived via `triggerFromGraph`.
5. Return `{ flow, setup }` where `setup` is unresolved bindings + the
   template's declared `notes.setup` + integrations referenced but not
   connected (reusing `missingIntegrations` from `src/lib/templates/instantiate.ts`).
6. Land in the builder with a "Finish setup" panel. Each item deep-links:
   *Connect Salesforce* → integrations; *Pick an agent* → focuses that node.

Rejected: a binding wizard before creation (a wall between the user and seeing
the flow, and it hard-blocks when an integration isn't connected yet), and
restricting templates to connection-free nodes (rules out the pipelines worth
templating).

### 5. Surfaces

- **Third tab in `/templates`** ("Flows"), inside the existing
  `templates-view.tsx` — inherits search, category filter, AI search,
  pagination, and the publish-to-community dialog.
- **`/flow-templates/[id]`** detail page, mirroring `/templates/[id]`:
  objective, the step list rendered from `notes.steps`, setup checklist,
  decision rules, failure handling, example output, "Use this flow".
  v1 renders a static ordered node list, not a live canvas preview.
- **Flows-page dropdown** reads the catalog API instead of the hardcoded array.
  Today's three `STARTER_TEMPLATES` migrate into the built-in catalog and
  `starter-templates.ts` is deleted.
- **"Save as template"** in the flow builder's overflow menu: captures the
  current graph, AI-drafts the notes object from it, user edits name/category/
  tags/notes, optional publish-to-community.

### 6. Built-in seed catalog

`src/lib/flows/templates/builtin/`, one file per template, each exporting a
`FlowTemplateDef`. Eight, chosen to span the palette:

| Template | Showcases |
| --- | --- |
| Summarize & extract *(migrated)* | ai |
| Score each item in a list *(migrated)* | per-item |
| Scheduled check with a delay *(migrated)* | wait |
| Churn-risk scorecard | poll → http pagination → per-item score → filter → join → code rank → output |
| Renewal brief (60/30/15 day) | schedule → tool → switch → agent → human review |
| Inbound webhook triage | webhook → categorize → switch → parallel → stop |
| CSV enrichment pipeline | file input → parse CSV → per-item http → code → csvTable |
| Nightly sync with retry | schedule → pagination → variable accumulation → condition → wait |

Built-ins are served alongside DB rows exactly as `builtInTemplates` is in the
agent-templates route: stored first (own before community), built-ins last.

### 7. AI-generated proposals

`generate-proposals.ts` already emits the `flow_template` kind, and
`api/template-proposals/[id]/accept` already calls `generateFlowGraph` to wire
one on accept. Change: accept writes a **FlowTemplate row**
(`source: 'ai_generated'`) and then instantiates *that* through the §4 path.
One instantiate path for every origin, and the recommendation stays in the
catalogue for reuse instead of being consumed once.

### 8. Testing

- **Built-in catalog** — every graph parses `flowGraphSchema`; node ids unique;
  `validateFlowGraph` reports no errors other than missing-binding errors on
  nodes that declare a binding; notes invariants from §2; no `{{` in notes.
- **`instantiateFlowTemplate`** — id rewriting collision-free and edge-consistent;
  resolved bindings written through; unresolved bindings surface as setup items;
  flow lands DRAFT.
- **Notes drafting** — model output schema-validated, `{{`-free.
- **API** — org scoping, cross-org global community read, publish/unpublish,
  delete-only-own; mirroring the existing agent-templates tests.

## Out of scope

Template versioning (flows already have `FlowVersion`; a template is a
snapshot), install counts and ratings, a parameter-substitution language (the
setup checklist covers it), template forking and diffing.
