/**
 * Flow tool catalog — the connections a flow's tool step can call.
 *
 * Flows draw from the SAME four tool planes as agents (see
 * @/features/agents/tool-planes): People.ai (Sales AI), per-org MCP connections,
 * native built-ins (Granola/Slack/HTTP/Email), and Nango provider tools.
 *
 * Connection id scheme (stored in a tool node's `connectionId`; see
 * @/lib/flows/tool-connection-id for the parser the executor routes on):
 *   - MCP connection rows keep their RAW database id — backward compatible
 *     with graphs stored before multi-plane support.
 *   - people_ai:backstory  — the People.ai / Sales AI plane
 *   - native:<providerId>  — a built-in integration (granola|slack|http|email)
 *   - nango:<capability>   — a Nango delivery capability (slack|gmail|salesforce)
 *
 * Return shape is unchanged ({ id, name, tools[] }[]); new planes appear as
 * additional entries. A plane that errors degrades to no/empty entries — the
 * catalog never throws for one bad plane. No secrets are ever included: only
 * ids, names, and tool schemas.
 */
import {
  loadMcpConnectionPlaneGroups,
  loadNangoPlaneGroups,
  loadNativePlaneGroups,
  loadPeopleAiPlaneGroup,
  type ToolPlaneGroup,
} from '@/features/agents/tool-planes'
import { planesForConnectionIds } from '@/lib/flows/tool-connection-id'

export { mcpConnectionScope } from '@/features/agents/tool-planes'

export type FlowToolSummary = { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }
export type FlowToolCatalogConnection = { id: string; name: string; tools: FlowToolSummary[]; toolsError?: string }

export async function loadFlowToolCatalog(
  organizationId: string,
  options: { userId?: string; takeConnections?: number; takeTools?: number; connectionIds?: string[] } = {},
): Promise<FlowToolCatalogConnection[]> {
  // When the caller only needs specific connections (run/publish validation),
  // load just the planes those ids reference.
  const wanted = options.connectionIds?.length ? planesForConnectionIds(options.connectionIds) : null
  const wantPlane = (plane: 'people_ai' | 'mcp' | 'native' | 'nango') => !wanted || wanted.planes.has(plane)

  const [peopleAi, mcp, native, nango] = await Promise.all([
    wantPlane('people_ai') ? loadPeopleAiPlaneGroup(organizationId, options.userId).catch(() => null) : null,
    wantPlane('mcp') && (!wanted || wanted.mcpIds.length)
      ? loadMcpConnectionPlaneGroups(organizationId, options.userId, {
          connectionIds: wanted?.mcpIds,
          take: options.takeConnections ?? 25,
        }).catch(() => [] as ToolPlaneGroup[])
      : [],
    wantPlane('native') ? loadNativePlaneGroups(organizationId).catch(() => [] as ToolPlaneGroup[]) : [],
    wantPlane('nango') ? loadNangoPlaneGroups(organizationId, options.userId).catch(() => [] as ToolPlaneGroup[]) : [],
  ])

  // MCP rows stay first so existing pickers/graphs see a stable ordering, then
  // the Sales AI plane, then the remaining planes.
  const groups = [...mcp, ...(peopleAi ? [peopleAi] : []), ...native, ...nango]
  const wantedIds = wanted ? new Set(options.connectionIds) : null
  return groups
    .filter((group) => !wantedIds || wantedIds.has(group.id))
    .map((group) => ({
      id: group.id,
      name: group.name,
      // Carried to the client so the builder can tell that an HTTP step is
      // really a hand-built call to a server this workspace has connected. Not
      // sensitive: it is the endpoint the user typed to connect it.
      ...(group.serverUrl ? { serverUrl: group.serverUrl } : {}),
      ...(group.toolsError ? { toolsError: group.toolsError } : {}),
      tools: group.tools.slice(0, options.takeTools ?? 100).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? null,
        outputSchema: tool.outputSchema ?? null,
      })),
    }))
}
