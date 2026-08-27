# @backstory/sdk

Typed, side-effect-free builders for Backstory workflow graphs and agent definitions, plus a public API/MCP client and a focused evaluation runner.

```ts
import { BackstoryClient, workflow, defineAgent, defineTool } from '@backstory/sdk'

const graph = workflow().trigger({
  type: 'manual',
  inputFields: [{ name: 'account', type: 'string', required: true }],
})
const output = graph.node('output', { outputs: [{ name: 'account', value: '{{trigger.input.account}}', type: 'text' }] })
graph.connect('trigger', output)

const lookup = defineTool({
  name: 'lookup_account',
  description: 'Look up an account.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: async ({ id }: { id: string }) => ({ id }),
})

const agent = defineAgent({ name: 'Researcher', instructions: 'Research the requested account.', tools: [lookup] })
const client = new BackstoryClient({ baseUrl: 'https://studio.example.com', apiKey: process.env.BACKSTORY_API_KEY! })
await client.createFlow({ name: 'Account lookup', graph: graph.toJSON() })
```

`FlowBuilder.toJSON()` validates ids, trigger count, type versions, and edge endpoints. The returned graph uses Backstory graph schema v2—including native connection types and indexed ports—and round-trips through `FlowBuilder.fromJSON()`. `BackstoryClient` supports flow list/get/create/update/delete/run plus scoped MCP tool calls.
