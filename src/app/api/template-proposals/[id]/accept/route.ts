import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { getProposal, markAccepted, stampCreatedTemplate, reopenUnfulfilled } from '@/lib/templates/proposals'
import { createTemplate } from '@/lib/templates/create-template'
import {
  proposalToCreateTemplateArgs,
  proposalImprovementTarget,
} from '@/lib/templates/accept-proposal'
import { provisionAgentFromConfig, missingIntegrations, findAgentFromTemplate } from '@/lib/templates/instantiate'
import { generateFlowGraph } from '@/lib/flows/generate-flow-graph'
import { createFlowTemplate } from '@/lib/flows/templates/create'
import { serializeFlowTemplate } from '@/lib/flows/templates/catalogue'
import { instantiateFlowTemplate, loadBindingContext } from '@/lib/flows/templates/instantiate'
import { draftFlowTemplateNotes, inferBindings } from '@/lib/flows/templates/draft-notes'
import { recordEstimatedUsage } from '@/lib/usage/ai-guard'
import { apiLogger } from '@/lib/logger'
import { captureError } from '@/lib/observability/sentry'

export const runtime = 'nodejs'
// Accepting a flow_template generates a wired graph via the model (up to 3 calls
// + repair rounds), so give the request room beyond the default.
export const maxDuration = 120

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

// POST /api/template-proposals/[id]/accept — promote an open proposal.
//   agent_template | flow_template → create a real org-scoped, AI-generated
//     AgentTemplate via A's single writer, stamp createdTemplateId, AND provision
//     the live artifact it describes: a wired flow for a flow_template, otherwise
//     (and whenever that generation fails) an ACTIVE agent in the workspace. The
//     response always names what to open — accepting is never a catalogue-only
//     write the user cannot find.
//   process_improvement → create NO template; return the flow/agent editor target
//     for D to open prefilled.
// Idempotent: an already-accepted/dismissed proposal returns its current state
// without re-creating (mirrors decideApproval's non-pending short-circuit).
// Org-scoped: a missing/other-org proposal 404s.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Proposal id is required')

  const proposal = await getProposal(id, auth.organizationId)
  if (!proposal) throw new ApiError('Proposal not found', 404, 'NOT_FOUND')

  const isImprovement = proposal.kind === 'process_improvement'

  // Idempotent: terminal proposals report their existing outcome, never re-create.
  if (proposal.status !== 'open') {
    if (proposal.status === 'accepted') {
      if (isImprovement) return { status: 'accepted', open: proposalImprovementTarget(proposal) }
      // Re-applying must still LAND the user on the agent the first accept built.
      // A bare templateId is not something any surface can open, so a second
      // Apply used to look — correctly — like it did nothing.
      const existing = proposal.createdTemplateId
        ? await findAgentFromTemplate(auth.organizationId, proposal.createdTemplateId).catch(() => null)
        : null
      return {
        status: 'accepted',
        templateId: proposal.createdTemplateId,
        ...(existing ? { kind: 'agent', agentId: existing.id } : {}),
      }
    }
    return { status: proposal.status }
  }

  if (isImprovement) {
    // No template — the client opens the existing flow/agent editor prefilled.
    await markAccepted(id, auth.organizationId)
    return { status: 'accepted', open: proposalImprovementTarget(proposal) }
  }

  // Template kind: the ONLY path that creates a live template — always via A's
  // writer as an org-scoped, AI-generated template (never global, never cross-org).
  //
  // Claim the proposal atomically BEFORE creating anything: markAccepted's
  // status:'open' guard means only one accept can win, so a retry after a partial
  // failure — or a concurrent double-accept — can never mint a duplicate template.
  const claim = await markAccepted(id, auth.organizationId)
  if (claim.count === 0) {
    // Lost the claim (already accepted/dismissed) — return the current outcome
    // idempotently rather than creating a second template.
    const current = await getProposal(id, auth.organizationId)
    if (current?.status === 'accepted') {
      // Same as the idempotent path above: name the agent the winning accept
      // built (null while it is still provisioning) so this caller can land too.
      const existing = current.createdTemplateId
        ? await findAgentFromTemplate(auth.organizationId, current.createdTemplateId).catch(() => null)
        : null
      return {
        status: 'accepted',
        templateId: current.createdTemplateId,
        ...(existing ? { kind: 'agent', agentId: existing.id } : {}),
      }
    }
    return { status: current?.status ?? 'dismissed' }
  }

  let template
  try {
    template = await createTemplate({
      ...proposalToCreateTemplateArgs(proposal),
      source: 'ai_generated',
      visibility: 'org',
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    })
  } catch (error) {
    // Creation failed after we claimed the proposal — reopen it so a retry can
    // create the template cleanly, instead of stranding an accepted row with no
    // template. (No-op if something already stamped it.)
    await reopenUnfulfilled(id, auth.organizationId).catch(() => undefined)
    throw error
  }
  // Record the created id for the idempotent-return path (best-effort: the
  // accept itself already committed, so a failure here only costs the id echo).
  await stampCreatedTemplate(id, auth.organizationId, template.id).catch(() => undefined)

  // 1-CLICK: accepting must always leave a LIVE artifact the user can open —
  // never a catalogue row they have to go find and instantiate. A flow_template
  // first tries the wired flow below; everything else (and any flow whose graph
  // could not be generated) becomes a live agent in the workspace.
  //
  // flow_template: generate the wired graph from the proposal's instructions via
  // the shared copilot pipeline (grounded on the org's real agents/tools, so
  // nodes reference ids that exist), then write it into the FLOW-TEMPLATE
  // catalogue and instantiate THAT through the same path every other template
  // takes. The recommendation stays reusable instead of being consumed once, and
  // there is one instantiate path regardless of where a template came from.
  if (proposal.kind === 'flow_template') {
    try {
      const config = asObj(proposal.configuration)
      const description = asStr(config.instructions) || proposal.title
      const { graph, rawParts } = await generateFlowGraph(auth.organizationId, auth.dbUser.id, description)
      recordEstimatedUsage(auth.organizationId, ...rawParts)

      const referenced = Array.isArray(config.integrations) ? config.integrations.filter((i): i is string => typeof i === 'string') : []
      const summary = asStr(config.description) || proposal.rationale
      const agentRoster = (await loadBindingContext(auth.organizationId, auth.dbUser.id)).agents
      const { notes, bindings } = await draftFlowTemplateNotes(graph, { name: template.name, description: summary, agents: agentRoster })
        // A notes-drafting failure must not cost the user their flow: fall back
        // to the rationale as the objective and infer bindings from the graph.
        .catch(() => ({
          notes: { objective: summary || proposal.title, inputs: [], steps: [], setup: [], customize: [] },
          bindings: inferBindings(graph, agentRoster),
        }))

      const flowTemplate = await createFlowTemplate({
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        name: template.name,
        description: summary,
        category: 'Suggested',
        graph,
        notes,
        bindings,
        integrations: referenced,
        source: 'ai_generated',
        visibility: 'org',
      })
      const { flow, setup } = await instantiateFlowTemplate(auth.organizationId, auth.dbUser.id, serializeFlowTemplate(flowTemplate, auth.organizationId))
      const missing = await missingIntegrations(auth.organizationId, auth.dbUser.id, referenced)
      return {
        status: 'accepted',
        kind: 'flow',
        templateId: template.id,
        flowTemplateId: flowTemplate.id,
        flowId: flow.id,
        setup,
        missingIntegrations: missing,
      }
    } catch (error) {
      // Graph generation is a multi-call model pipeline inside a 120s function —
      // an outage, a timeout, or an ungeneratable graph all land here. Falling
      // through to the agent path below means the user still gets something they
      // can run; swallowing it (as this used to) left Apply looking like a no-op.
      apiLogger.error('Flow provisioning failed for an accepted recommendation — falling back to an agent', {
        proposalId: id,
        templateId: template.id,
        error: error instanceof Error ? error.message : String(error),
      })
      captureError(error, { path: request.nextUrl.pathname, code: 'FLOW_PROVISION_FAILED' })
    }
  }

  // The agent path: instructions + integrations + the proposed cadence become an
  // ACTIVE agent, so accepting lands the user on a working agent in their
  // workspace. The template still exists in the library alongside it.
  try {
    const { agent, missing } = await provisionAgentFromConfig(
      auth.organizationId,
      auth.dbUser.id,
      proposal.configuration,
      template.name,
      template.id,
    )
    return { status: 'accepted', kind: 'agent', templateId: template.id, agentId: agent.id, missingIntegrations: missing }
  } catch (error) {
    // Nothing live could be created. Report that honestly — the client must not
    // announce a success the user then cannot find anywhere.
    apiLogger.error('Agent provisioning failed for an accepted recommendation', {
      proposalId: id,
      templateId: template.id,
      error: error instanceof Error ? error.message : String(error),
    })
    captureError(error, { path: request.nextUrl.pathname, code: 'AGENT_PROVISION_FAILED' })
    return { status: 'accepted', kind: 'template', templateId: template.id, provisioned: false }
  }
}, { permission: 'template.author', internalOnly: true })
