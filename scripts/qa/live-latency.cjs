/* Run with node --import tsx inside the existing worker. Only named, read-only
 * QA flows are dispatched. No integration credentials or source data is logged. */
async function main() {
  const { prisma } = require('./src/lib/prisma.ts')
  const { ambientOrganization } = require('./src/lib/tenant-database-context.ts')
  const { startFlowExecution } = require('./src/features/flows/execute-flow.ts')
  const { validateArtifactRuntime } = require('./src/lib/artifacts/preflight.ts')
  const organizationId = process.env.QA_ORGANIZATION_ID
  const userId = process.env.QA_USER_ID
  if (!organizationId || !userId) throw Error('QA_ORGANIZATION_ID and QA_USER_ID are required')
  const report = { timestamp: new Date().toISOString(), flows: [], validators: [] }
  await ambientOrganization.run(organizationId, async () => {
    const cases = [
      { id: 'cmuozfmvy0015q7ppc7luydk1', name: 'QA — 19 Loop concurrency and ordered output', input: [1, 2, 3, 4, 5] },
      { id: 'cmuozd087000zq7o9gpqku841', name: 'QA — 05 JavaScript Python and conditional merge', input: [1, 2, 3, 4] },
    ]
    for (const item of cases) {
      const flow = await prisma.flow.findFirst({ where: { id: item.id, organizationId }, select: { name: true, graph: true } })
      if (!flow || flow.name !== item.name) throw Error('QA flow identity mismatch')
      if (flow.graph.nodes.some(node => ['tool', 'agent', 'http', 'subflow'].includes(node.type))) throw Error('Refusing flow with external effects')
    }
    const rounds = Math.min(20, Math.max(1, Number(process.env.QA_ROUNDS) || 3))
    for (let round = 0; round < rounds; round++) {
      const runs = await Promise.all(cases.map(async item => {
        const start = Date.now()
        const run = await startFlowExecution({ flowId: item.id, organizationId, userId, input: item.input, trigger: { type: 'manual', source: 'latency-qa' } })
        return { id: run.flowRunId, name: item.name, round, acceptedMs: Date.now() - start }
      }))
      for (const run of runs) {
        const deadline = Date.now() + 90_000
        for (;;) {
          const row = await prisma.flowRun.findFirst({ where: { id: run.id, organizationId }, select: { status: true, startedAt: true, finishedAt: true, error: true, steps: { select: { status: true, startedAt: true, finishedAt: true } } } })
          if (row?.finishedAt) {
            report.flows.push({ ...run, status: row.status, error: row.error, elapsedMs: row.finishedAt - row.startedAt, steps: row.steps.length })
            break
          }
          if (Date.now() > deadline) throw Error('QA flow exceeded 90s: ' + run.id)
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      const interval = Math.min(10_000, Math.max(0, Number(process.env.QA_INTERVAL_MS) || 0))
      if (interval && round < rounds - 1) await new Promise(resolve => setTimeout(resolve, interval))
    }
  })
  const candidates = [
    ['react-form', 'import React from "react"; export default function App(){const [v,setV]=React.useState("100");const [result,setResult]=React.useState("");return <form onSubmit={e=>{e.preventDefault();setResult(v)}}><input id="amount" value={v} onChange={e=>setV(e.target.value)}/><button id="save" type="submit">Save</button><p id="result">{result}</p></form>};window.__artifactTests=[{action:"fill",selector:"#amount",value:"150"},{action:"click",selector:"#save"},{action:"expectText",selector:"#result",value:"150"}];'],
    ['javascript', '<html><body><h1>QA JavaScript</h1><button id="go" onclick="document.querySelector(\'#result\').textContent=\'42\'">Calculate</button><p id="result">Ready</p><script>window.__artifactTests=[{action:"click",selector:"#go"},{action:"expectText",selector:"#result",value:"42"}]</script></body></html>'],
    ['typescript', 'import React from "react"; export default function App(){const [n,setN]=React.useState<number>(0);return <main><h1>QA TypeScript</h1><button id="go" onClick={()=>setN(42)}>Calculate</button><p id="result">{n}</p></main>}; window.__artifactTests=[{action:"click",selector:"#go"},{action:"expectText",selector:"#result",value:"42"}];'],
    ['python', '<html><body><h1>QA Python</h1><button id="go">Calculate</button><p id="result">Ready</p><script>document.querySelector("#go").onclick=async()=>{const n=await BackstoryArtifact.runPython("sum(input[\\"values\\"])",{values:[20,22]});document.querySelector("#result").textContent=String(n)};window.__artifactTests=[{action:"click",selector:"#go"},{action:"expectText",selector:"#result",value:"42"}]</script></body></html>'],
  ]
  // Avoid manufacturing validator overload: its configured admission is three.
  for (const [kind, content] of candidates) {
    const start = Date.now()
    try { await validateArtifactRuntime(content); report.validators.push({ kind, ok: true, ms: Date.now() - start }) }
    catch (error) { report.validators.push({ kind, ok: false, ms: Date.now() - start, error: error.message }) }
  }
  console.log(JSON.stringify(report))
  if (report.flows.some(run => run.status !== 'succeeded') || report.validators.some(run => !run.ok)) process.exitCode = 1
}
main().then(() => process.exit(process.exitCode || 0)).catch(error => { console.error(error.message); process.exit(1) })
