/**
 * Demo-mode snapshot: clone a real workspace into a disposable demo org,
 * anonymising every value as it copies.
 *
 * The demo org must contain NO real value at all — that absence, not any
 * downstream masking, is what makes demo sessions safe to record. Three
 * passes:
 *
 *  1. HARVEST — walk everything that will be copied and teach the alias book
 *     the entities that live in free text (email domains, CRM account names),
 *     plus every member and the workspace itself.
 *  2. COPY — clone rows table by table, old→new id maps threading the FKs,
 *     every text and JSON column through the anonymiser, credentials never.
 *  3. Nothing — there is no fix-up pass; a value either left as fiction or
 *     did not leave.
 *
 * Runs on systemPrisma like org-teardown: the clone enumerates rows of the
 * SOURCE org and writes rows of the demo org, both pinned by id, outside any
 * per-request tenant context. The model-coverage guard test keeps the four
 * placement lists below exhaustive as the schema grows.
 */

import { randomUUID } from 'node:crypto'
import { systemPrisma } from '@/lib/prisma'
import { createAliasBook, type AliasBook } from './alias'
import { anonymizeJson, anonymizeText, harvestAliases } from './anonymize'

/** Copied completely. */
export const COPY_FULL = [
  'User', 'Team', 'AgentTeammate', 'AgentTask', 'AgentConnector', 'AgentTemplate',
  'Flow', 'FlowVersion', 'FlowTemplate', 'FlowTemplateVersion', 'SharedSkill',
  'KnowledgeDocument', 'KnowledgeChunk', 'SignalSubscription', 'CustomSignal',
  'WorkspaceFolder',
] as const

/** Copied with a recency bound — history is for looking populated. */
export const COPY_BOUNDED = [
  'FlowRun', 'AgentExecution', 'AgentChatSession', 'AgentChatMessage',
  'AgentMemory', 'Notification', 'Signal', 'HuddleSegment', 'HuddleNote',
] as const

/** Copied as credential-free shells that render as connected. */
export const COPY_SHELL = ['Integration', 'NangoConnection', 'McpConnection', 'PeopleAiConnection'] as const

/** Copied because their parent is, without an organizationId of their own. */
export const PARENT_SCOPED_COPIES = [
  'TeamMember', 'FlowCollaborator', 'FlowRunStep', 'ExecutionMessage', 'WorkflowStep', 'WorkflowEvent',
] as const

/** Never copied — each with the reason a reviewer needs. */
export const EXCLUDED: Record<string, string> = {
  AuditEvent: 'the audit trail is the record of the REAL workspace; a copy in a sandbox is noise at best',
  LlmCall: 'cost/latency accounting for real usage; demo runs write their own rows',
  ModelEvalResult: 'platform-level model quality measurements (same family as LlmCall); a demo copy would double-count real scores',
  OutboxEvent: 'delivery queue — copying would re-deliver real events',
  FlowSideEffect: 'idempotency ledger for real deliveries; meaningless against canned transports',
  FlowWebhookReceipt: 'inbound webhook dedupe ledger tied to real endpoints',
  FlowEditSnapshot: 'editor autosave noise, not demo material',
  ApprovalRequest: 'pending approvals reference live executions; a demo must not look decidable',
  CatalogueSubmission: 'catalogue state is platform-global, not workspace scenery',
  TemplateProposal: 'generation pipeline state, regenerated on demand',
  IntegrationSecret: 'credential material — never enters a demo org',
  HttpCredential: 'credential material — never enters a demo org',
  ApiKey: 'credential material — never enters a demo org',
  ApiAccessToken: 'credential material — never enters a demo org',
  ScimToken: 'credential material — never enters a demo org',
  IdentityProvider: 'SSO wiring for the real workspace; a sandbox must not look SSO-governed',
  OrganizationDomain: 'verified-domain claims are real-workspace identity',
  Invitation: 'open invites would read as joinable from a sandbox',
  FeatureGrant: 'entitlement flags resolve against the REAL org before the tenant swap',
  PushSubscription: 'device endpoints — a demo org must not be able to notify real devices',
  StoredFile: 'binary storage with quota accounting; out of demo scope per the design',
  PlatformAllowedDomain: 'platform admission control — global policy, not workspace scenery',
  ActivityEvent: 'readers exist now (dispatchActivityEvent, the builder trigger surfaces) — this is excluded for a different reason: rows carry raw provider payloads (Slack message text, Salesforce/GitHub record bodies) and external ids (sourceEventId, actorExternalId) scoped to the REAL workspace\'s connected accounts, none of which is safe or meaningful to hand a sandbox that has no live connection behind it',
  ActivityTriggerClaim: 'exactly-once dispatch ledger tied to real event/flow ids — same class as FlowSideEffect',
  ActivitySourceCursor: 'backfill checkpoint tied to a real connection; meaningless without the connection it advances',
  AdoptionWeek: 'operator adoption aggregates for the REAL workspace, and the rollup job excludes demo orgs by construction — copying them in would be the one place demo activity could masquerade as real adoption',
  AgentCohortWeek: 'survival history for the REAL workspace\'s agents; same reason as AdoptionWeek',
}

const BOUND = 25
const WIDE_BOUND = 100

type Ids = Map<string, string>
const remap = (ids: Ids, old: string | null | undefined): string | undefined =>
  old ? ids.get(old) : undefined

/**
 * Drop null/undefined keys so nullable columns take their DB default (NULL).
 * The mapped return type is what lets rows read via findMany (whose Json
 * columns type as `JsonValue | null`) feed create() (which forbids a bare
 * top-level null on Json inputs): stripping nulls at runtime and in the type
 * is one move.
 */
function compact<T extends Record<string, unknown>>(row: T): { [K in keyof T]: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)) as { [K in keyof T]: NonNullable<T[K]> }
}

/** Anonymise every value of a row except ids, dates, and mechanical fields. */
function anonRow<T extends Record<string, unknown>>(row: T, book: AliasBook): T {
  const SKIP = /(^id$|Id$|Ids$|At$|^slug$|^status$|^kind$|^type$|^role$|^visibility$|^provider|^connectionId$|^authType$|^healthStatus$|^embedding|Hash$|Digest$|^dedupeKey$|^idempotencyKey$|^scopes$|^grantedScopes$|^model$|^folder$|^category$|^source$|^catalogueStatus$|^priority$|^agentType$|^timezone$|^mimeType$|^schedule$)/
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (SKIP.test(key) || value == null) return [key, value]
      if (typeof value === 'string' || Array.isArray(value) || (typeof value === 'object' && value.constructor === Object)) {
        return [key, anonymizeJson(value, book)]
      }
      return [key, value]
    }),
  ) as T
}

export async function ensureDemoWorkspace(
  realOrgId: string,
  ownerUserId: string,
): Promise<{ demoOrgId: string; created: boolean }> {
  // Sessions persist until exited: re-entry reuses the standing sandbox so a
  // multi-day shoot keeps the same fictional companies and history.
  const existing = await systemPrisma.organization.findUnique({ where: { demoOwnerUserId: ownerUserId } })
  if (existing) return { demoOrgId: existing.id, created: false }

  // systemPrisma: the clone reads the source org and writes the demo org, both
  // pinned by explicit org id; it runs outside any authenticated tenant context.
  const real = await systemPrisma.organization.findUniqueOrThrow({ where: { id: realOrgId } })
  const book = createAliasBook(realOrgId)

  const users = await systemPrisma.user.findMany({ where: { organizationId: realOrgId } })
  const teams = await systemPrisma.team.findMany({ where: { organizationId: realOrgId } })
  const teammates = await systemPrisma.agentTeammate.findMany({ where: { organizationId: realOrgId } })
  const agents = await systemPrisma.agentTask.findMany({ where: { organizationId: realOrgId } })
  const flows = await systemPrisma.flow.findMany({ where: { organizationId: realOrgId } })
  const orgCompany = book.company(real.name)

  // ── Harvest ──────────────────────────────────────────────────────────────
  for (const user of users) book.person({ name: user.name, email: user.email, companyName: real.name })
  harvestAliases([agents, flows], book)

  const signals = await systemPrisma.signal.findMany({
    where: { organizationId: realOrgId }, orderBy: { receivedAt: 'desc' }, take: WIDE_BOUND * 2,
  })
  harvestAliases(signals.map((signal) => signal.payload), book)

  // ── Copy ─────────────────────────────────────────────────────────────────
  const demoOrgId = randomUUID()
  await systemPrisma.organization.create({
    data: {
      id: demoOrgId,
      // The sandbox presents AS the fictional company — the workspace name in
      // the org switcher is itself capture material.
      name: orgCompany.name,
      slug: `demo-${demoOrgId.slice(0, 8)}`,
      logoUrl: book.logoDataUrl(orgCompany.name),
      plan: real.plan,
      kind: 'demo',
      demoOfOrganizationId: realOrgId,
      demoOwnerUserId: ownerUserId,
      // The entitlement gate judges the real org before the tenant swap, but
      // background paths resolve entitlement by org id — mirror the fields so
      // a demo run is entitled exactly when the real workspace is.
      entitlementTier: real.entitlementTier,
      entitlementStatus: real.entitlementStatus,
      entitlementCheckedAt: real.entitlementCheckedAt,
      aiEgressPolicy: real.aiEgressPolicy,
      trialEndDate: real.trialEndDate,
      mfaPolicy: 'optional',
      ssoEnforced: false,
    },
  })

  const userIds: Ids = new Map()
  for (const user of users) {
    const alias = book.person({ name: user.name, email: user.email, companyName: real.name })
    const id = randomUUID()
    userIds.set(user.id, id)
    await systemPrisma.user.create({
      data: {
        id,
        // A shadow member can render but never authenticate: the generated
        // supabaseId matches no real identity.
        supabaseId: randomUUID(),
        email: user.email ? alias.email : null,
        name: user.name ? alias.name : null,
        imageUrl: user.imageUrl ? book.logoDataUrl(alias.name) : null,
        role: user.role,
        platformRole: null,
        organizationId: demoOrgId,
        isActive: true,
        timezone: user.timezone,
        lastSeenAt: user.lastSeenAt,
      },
    })
  }
  const owner = (realId: string | null | undefined): string => remap(userIds, realId) ?? (userIds.get(ownerUserId) as string)

  const teamIds: Ids = new Map()
  for (const team of teams) {
    const id = randomUUID()
    teamIds.set(team.id, id)
    await systemPrisma.team.create({ data: compact(anonRow({ ...team, id, organizationId: demoOrgId }, book)) })
  }
  const teamMembers = await systemPrisma.teamMember.findMany({ where: { teamId: { in: teams.map((team) => team.id) } } })
  for (const member of teamMembers) {
    const userId = remap(userIds, member.userId)
    const teamId = remap(teamIds, member.teamId)
    if (!userId || !teamId) continue
    await systemPrisma.teamMember.create({ data: { id: randomUUID(), teamId, userId, teamRole: member.teamRole } })
  }

  const teammateIds: Ids = new Map()
  for (const teammate of teammates) {
    const id = randomUUID()
    teammateIds.set(teammate.id, id)
    await systemPrisma.agentTeammate.create({ data: compact(anonRow({ ...teammate, id, organizationId: demoOrgId }, book)) })
  }

  // Connection shells before agents, so agent connectors can re-point at them.
  const mcpIds: Ids = new Map()
  for (const connection of await systemPrisma.mcpConnection.findMany({ where: { organizationId: realOrgId } })) {
    const id = randomUUID()
    mcpIds.set(connection.id, id)
    await systemPrisma.mcpConnection.create({
      data: compact({
        ...anonRow({ ...connection, id, organizationId: demoOrgId }, book),
        userId: remap(userIds, connection.userId),
        authConfig: {},
        lastError: null,
      }),
    })
  }
  for (const connection of await systemPrisma.nangoConnection.findMany({ where: { organizationId: realOrgId } })) {
    await systemPrisma.nangoConnection.create({
      data: compact({
        ...anonRow({ ...connection, id: randomUUID(), organizationId: demoOrgId }, book),
        userId: remap(userIds, connection.userId),
        connectionId: `demo-${randomUUID().slice(0, 8)}`,
        metadata: {},
        lastError: null,
      }),
    })
  }
  for (const integration of await systemPrisma.integration.findMany({ where: { organizationId: realOrgId } })) {
    const userId = remap(userIds, integration.userId)
    if (!userId) continue
    await systemPrisma.integration.create({
      data: compact({
        ...anonRow({ ...integration, id: randomUUID(), organizationId: demoOrgId }, book),
        userId,
        metadata: {},
        lastError: null,
      }),
    })
  }
  for (const connection of await systemPrisma.peopleAiConnection.findMany({ where: { organizationId: realOrgId } })) {
    const userId = remap(userIds, connection.userId)
    if (!userId) continue
    await systemPrisma.peopleAiConnection.create({
      data: compact({
        ...anonRow({ ...connection, id: randomUUID(), organizationId: demoOrgId }, book),
        userId,
        membershipId: null,
        accessToken: 'demo',
        refreshToken: null,
      }),
    })
  }

  const agentIds: Ids = new Map()
  for (const agent of agents) {
    const id = randomUUID()
    agentIds.set(agent.id, id)
    await systemPrisma.agentTask.create({
      data: compact({
        ...anonRow({ ...agent, id, organizationId: demoOrgId }, book),
        userId: owner(agent.userId),
        teammateId: remap(teammateIds, agent.teammateId),
      }),
    })
  }
  for (const connector of await systemPrisma.agentConnector.findMany({ where: { organizationId: realOrgId } })) {
    const agentTaskId = remap(agentIds, connector.agentTaskId)
    if (!agentTaskId) continue
    await systemPrisma.agentConnector.create({
      data: compact({
        ...anonRow({ ...connector, id: randomUUID(), organizationId: demoOrgId }, book),
        agentTaskId,
        mcpConnectionId: remap(mcpIds, connector.mcpConnectionId),
      }),
    })
  }

  const flowIds: Ids = new Map()
  for (const flow of flows) {
    const id = randomUUID()
    flowIds.set(flow.id, id)
    await systemPrisma.flow.create({
      data: compact({
        ...anonRow({ ...flow, id, organizationId: demoOrgId }, book),
        userId: owner(flow.userId),
        shareTokenDigest: null,
        anonymousViews: 0,
      }),
    })
  }
  for (const version of await systemPrisma.flowVersion.findMany({ where: { organizationId: realOrgId } })) {
    const flowId = remap(flowIds, version.flowId)
    if (!flowId) continue
    await systemPrisma.flowVersion.create({
      data: compact({
        ...anonRow({ ...version, id: randomUUID(), organizationId: demoOrgId }, book),
        flowId,
        publishedBy: remap(userIds, version.publishedBy) ?? null,
      }),
    })
  }
  for (const collaborator of await systemPrisma.flowCollaborator.findMany({ where: { flowId: { in: flows.map((flow) => flow.id) } } })) {
    const flowId = remap(flowIds, collaborator.flowId)
    const userId = remap(userIds, collaborator.userId)
    if (!flowId || !userId) continue
    await systemPrisma.flowCollaborator.create({ data: { id: randomUUID(), flowId, userId, role: collaborator.role } })
  }

  const templateIds: Ids = new Map()
  for (const template of await systemPrisma.flowTemplate.findMany({ where: { organizationId: realOrgId } })) {
    const id = randomUUID()
    templateIds.set(template.id, id)
    await systemPrisma.flowTemplate.create({
      data: compact({ ...anonRow({ ...template, id, organizationId: demoOrgId }, book), userId: owner(template.userId) }),
    })
  }
  for (const version of await systemPrisma.flowTemplateVersion.findMany({ where: { organizationId: realOrgId } })) {
    const templateId = remap(templateIds, version.templateId)
    if (!templateId) continue
    await systemPrisma.flowTemplateVersion.create({
      data: compact({
        ...anonRow({ ...version, id: randomUUID(), organizationId: demoOrgId }, book),
        templateId,
        savedBy: remap(userIds, version.savedBy) ?? null,
      }),
    })
  }
  const agentTemplateIds: Ids = new Map()
  for (const template of await systemPrisma.agentTemplate.findMany({ where: { organizationId: realOrgId } })) {
    const id = randomUUID()
    agentTemplateIds.set(template.id, id)
    await systemPrisma.agentTemplate.create({
      data: compact({ ...anonRow({ ...template, id, organizationId: demoOrgId }, book), userId: owner(template.userId) }),
    })
  }
  for (const skill of await systemPrisma.sharedSkill.findMany({ where: { organizationId: realOrgId } })) {
    await systemPrisma.sharedSkill.create({
      data: compact({
        ...anonRow({ ...skill, id: randomUUID(), organizationId: demoOrgId }, book),
        userId: remap(userIds, skill.userId),
      }),
    })
  }

  const documentIds: Ids = new Map()
  for (const document of await systemPrisma.knowledgeDocument.findMany({ where: { organizationId: realOrgId } })) {
    const id = randomUUID()
    documentIds.set(document.id, id)
    await systemPrisma.knowledgeDocument.create({
      data: compact({
        ...anonRow({ ...document, id, organizationId: demoOrgId }, book),
        agentId: remap(agentIds, document.agentId),
        userId: remap(userIds, document.userId),
      }),
    })
  }
  for (const chunk of await systemPrisma.knowledgeChunk.findMany({ where: { organizationId: realOrgId } })) {
    const documentId = remap(documentIds, chunk.documentId)
    if (!documentId) continue
    await systemPrisma.knowledgeChunk.create({
      data: compact({
        ...anonRow({ ...chunk, id: randomUUID(), organizationId: demoOrgId }, book),
        documentId,
        agentId: remap(agentIds, chunk.agentId),
        embedding: undefined,
      }),
    })
  }

  const signalIds: Ids = new Map()
  for (const signal of signals) {
    const id = randomUUID()
    signalIds.set(signal.id, id)
    await systemPrisma.signal.create({
      data: compact({
        ...anonRow({ ...signal, id, organizationId: demoOrgId }, book),
        accountId: null,
        opportunityId: null,
        stakeholderId: null,
        provenanceUrl: null,
        dedupeKey: `demo-${randomUUID()}`,
      }),
    })
  }
  for (const subscription of await systemPrisma.signalSubscription.findMany({ where: { organizationId: realOrgId } })) {
    const agentTaskId = remap(agentIds, subscription.agentTaskId)
    if (!agentTaskId) continue
    await systemPrisma.signalSubscription.create({
      data: compact({
        ...anonRow({ ...subscription, id: randomUUID(), organizationId: demoOrgId }, book),
        agentTaskId,
        createdById: remap(userIds, subscription.createdById) ?? null,
      }),
    })
  }
  for (const signal of await systemPrisma.customSignal.findMany({ where: { organizationId: realOrgId } })) {
    await systemPrisma.customSignal.create({
      data: compact({ ...anonRow({ ...signal, id: randomUUID(), organizationId: demoOrgId }, book), userId: owner(signal.userId) }),
    })
  }
  for (const folder of await systemPrisma.workspaceFolder.findMany({ where: { organizationId: realOrgId } })) {
    await systemPrisma.workspaceFolder.create({
      data: compact(anonRow({ ...folder, id: randomUUID(), organizationId: demoOrgId }, book)),
    })
  }

  // ── Bounded history ──────────────────────────────────────────────────────
  const executionIds: Ids = new Map()
  for (const agent of agents) {
    const executions = await systemPrisma.agentExecution.findMany({
      where: { agentTaskId: agent.id }, orderBy: { startedAt: 'desc' }, take: BOUND,
    })
    for (const execution of executions) {
      const id = randomUUID()
      executionIds.set(execution.id, id)
      await systemPrisma.agentExecution.create({
        data: compact({
          ...anonRow({ ...execution, id, organizationId: demoOrgId }, book),
          userId: owner(execution.userId),
          agentTaskId: remap(agentIds, execution.agentTaskId),
          agentTemplateId: remap(agentTemplateIds, execution.agentTemplateId),
          signalId: remap(signalIds, execution.signalId),
          idempotencyKey: null,
        }),
      })
    }
  }
  const executionIdList = [...executionIds.keys()]
  for (const message of await systemPrisma.executionMessage.findMany({ where: { executionId: { in: executionIdList } } })) {
    await systemPrisma.executionMessage.create({
      data: {
        id: randomUUID(),
        executionId: executionIds.get(message.executionId) as string,
        role: message.role,
        content: anonymizeText(message.content, book),
        createdAt: message.createdAt,
      },
    })
  }
  const stepIds: Ids = new Map()
  for (const step of await systemPrisma.workflowStep.findMany({ where: { executionId: { in: executionIdList } } })) {
    const id = randomUUID()
    stepIds.set(step.id, id)
    await systemPrisma.workflowStep.create({
      data: compact({ ...anonRow({ ...step, id }, book), executionId: executionIds.get(step.executionId) as string }),
    })
  }
  for (const event of await systemPrisma.workflowEvent.findMany({ where: { executionId: { in: executionIdList } } })) {
    await systemPrisma.workflowEvent.create({
      data: compact({
        ...anonRow({ ...event, id: randomUUID() }, book),
        executionId: executionIds.get(event.executionId) as string,
        stepId: remap(stepIds, event.stepId),
      }),
    })
  }

  for (const flow of flows) {
    const runs = await systemPrisma.flowRun.findMany({
      where: { flowId: flow.id }, orderBy: { startedAt: 'desc' }, take: BOUND,
    })
    for (const run of runs) {
      const id = randomUUID()
      await systemPrisma.flowRun.create({
        data: compact({
          ...anonRow({ ...run, id, organizationId: demoOrgId }, book),
          flowId: flowIds.get(flow.id) as string,
          userId: remap(userIds, run.userId),
          resumeTokenHash: null,
        }),
      })
      for (const step of await systemPrisma.flowRunStep.findMany({ where: { flowRunId: run.id } })) {
        await systemPrisma.flowRunStep.create({
          data: compact({
            ...anonRow({ ...step, id: randomUUID() }, book),
            flowRunId: id,
            agentExecutionId: remap(executionIds, step.agentExecutionId),
          }),
        })
      }
    }
  }

  const sessionIds: Ids = new Map()
  for (const session of await systemPrisma.agentChatSession.findMany({
    where: { organizationId: realOrgId }, orderBy: { updatedAt: 'desc' }, take: WIDE_BOUND,
  })) {
    const agentTaskId = remap(agentIds, session.agentTaskId)
    if (!agentTaskId) continue
    const id = randomUUID()
    sessionIds.set(session.id, id)
    await systemPrisma.agentChatSession.create({
      data: compact({ ...anonRow({ ...session, id, organizationId: demoOrgId }, book), agentTaskId, userId: owner(session.userId) }),
    })
  }
  for (const message of await systemPrisma.agentChatMessage.findMany({
    where: { sessionId: { in: [...sessionIds.keys()] } },
  })) {
    const agentTaskId = remap(agentIds, message.agentTaskId)
    if (!agentTaskId) continue
    await systemPrisma.agentChatMessage.create({
      data: compact({
        ...anonRow({ ...message, id: randomUUID(), organizationId: demoOrgId }, book),
        agentTaskId,
        userId: owner(message.userId),
        sessionId: remap(sessionIds, message.sessionId),
      }),
    })
  }
  for (const memory of await systemPrisma.agentMemory.findMany({
    where: { organizationId: realOrgId }, orderBy: { updatedAt: 'desc' }, take: WIDE_BOUND * 2,
  })) {
    const agentId = remap(agentIds, memory.agentId)
    if (!agentId) continue
    await systemPrisma.agentMemory.create({
      data: compact({
        ...anonRow({ ...memory, id: randomUUID(), organizationId: demoOrgId }, book),
        agentId,
        sourceExecutionId: remap(executionIds, memory.sourceExecutionId),
        embedding: undefined,
      }),
    })
  }
  for (const notification of await systemPrisma.notification.findMany({
    where: { organizationId: realOrgId }, orderBy: { createdAt: 'desc' }, take: WIDE_BOUND,
  })) {
    await systemPrisma.notification.create({
      data: compact({
        ...anonRow({ ...notification, id: randomUUID(), organizationId: demoOrgId }, book),
        userId: remap(userIds, notification.userId),
        agentTaskId: remap(agentIds, notification.agentTaskId),
        executionId: remap(executionIds, notification.executionId),
        link: null,
      }),
    })
  }
  for (const segment of await systemPrisma.huddleSegment.findMany({
    where: { organizationId: realOrgId }, orderBy: { createdAt: 'desc' }, take: WIDE_BOUND,
  })) {
    const flowId = remap(flowIds, segment.flowId)
    if (!flowId) continue
    await systemPrisma.huddleSegment.create({
      data: compact({ ...anonRow({ ...segment, id: randomUUID(), organizationId: demoOrgId }, book), flowId }),
    })
  }
  for (const note of await systemPrisma.huddleNote.findMany({
    where: { organizationId: realOrgId }, orderBy: { createdAt: 'desc' }, take: WIDE_BOUND,
  })) {
    const flowId = remap(flowIds, note.flowId)
    if (!flowId) continue
    await systemPrisma.huddleNote.create({
      data: compact({ ...anonRow({ ...note, id: randomUUID(), organizationId: demoOrgId }, book), flowId }),
    })
  }

  return { demoOrgId, created: true }
}
