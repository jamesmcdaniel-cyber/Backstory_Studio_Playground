/* Explicit live test: creates three QA-only artifacts and runs the existing
 * read-only integration QA flow. Never touches the source/user artifact. */
async function main() {
  const { prisma } = require('./src/lib/prisma.ts')
  const { ambientOrganization } = require('./src/lib/tenant-database-context.ts')
  const { startFlowExecution } = require('./src/features/flows/execute-flow.ts')
  const organizationId = process.env.QA_ORGANIZATION_ID
  const userId = process.env.QA_USER_ID
  if (!organizationId || !userId) throw Error('QA_ORGANIZATION_ID and QA_USER_ID are required')
  const flowId = 'cmup8ubov000jq7x49eaj50gc'
  const marker = 'latency-qa-' + Date.now()
  await ambientOrganization.run(organizationId, async () => {
    const flow = await prisma.flow.findFirst({ where: { id: flowId, organizationId }, select: { name: true, graph: true } })
    if (flow?.name !== 'QA — Live artifact agent-flow stress') throw Error('QA flow identity mismatch')
    const allowedTools = ['github_list_repositories', 'salesforce_query', 'list_workflow_tags', 'top_records']
    for (const node of flow.graph.nodes) {
      if (!['trigger', 'code', 'tool', 'join', 'agent'].includes(node.type)) throw Error('Unexpected QA node type')
      if (node.type === 'tool' && !allowedTools.includes(node.data.toolName)) throw Error('Unexpected QA integration tool')
      if (node.type === 'agent' && node.data.toolPolicy?.mode !== 'none') throw Error('QA analyst must have no tools')
    }
    const tests = await Promise.all([0, 1, 2].map(async index => {
      const artifact = await prisma.artifact.create({ data: { organizationId, userId, title: `QA latency release ${marker} #${index + 1}`, kind: 'page', flowId, agentTaskId: 'cmup8u98x0001q7x4jj7rszoj' } })
      const started = Date.now()
      const run = await startFlowExecution({ flowId, organizationId, userId, input: { request: marker }, trigger: { type: 'manual', artifactId: artifact.id, artifactRequest: marker } })
      return { artifactId: artifact.id, runId: run.flowRunId, acceptedMs: Date.now() - started }
    }))
    console.log(JSON.stringify({ started: tests }))
    const report = []
    for (const test of tests) {
      const deadline = Date.now() + 240_000
      for (;;) {
        const run = await prisma.flowRun.findFirst({ where: { id: test.runId, organizationId }, select: { status: true, error: true, startedAt: true, finishedAt: true, steps: { select: { nodeId: true, status: true, startedAt: true, finishedAt: true, error: true } } } })
        if (run?.finishedAt) {
          const artifact = await prisma.artifact.findFirst({ where: { id: test.artifactId, organizationId }, select: { currentVersionId: true, versionCount: true } })
          const version = artifact?.currentVersionId && await prisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId }, select: { content: true } })
          const sources = version && version.content.match(/const rows=(\[.*?\]);/s)
          report.push({ ...test, status: run.status, error: run.error, elapsedMs: run.finishedAt - run.startedAt, versionCount: artifact?.versionCount, markerPresent: Boolean(version && version.content.includes(marker)), sources: sources ? JSON.parse(sources[1]) : null, steps: run.steps.map(step => ({ id: step.nodeId, status: step.status, ms: step.finishedAt && step.startedAt ? step.finishedAt - step.startedAt : null, error: step.error })) })
          break
        }
        if (Date.now() >= deadline) throw Error('QA run exceeded deadline: ' + test.runId)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    console.log(JSON.stringify({ results: report }))
    if (report.some(r => r.status !== 'succeeded' || !r.markerPresent || r.versionCount !== 1)) process.exitCode = 1
  })
}
main().then(() => process.exit(process.exitCode || 0)).catch(error => { console.error(error.message); process.exit(1) })
