# Backstory TypeScript SDK

Create a scoped key in **Settings → Developer API**, then:

```ts
import { BackstoryClient } from '@backstory-studio/sdk'

const backstory = new BackstoryClient({ apiKey: process.env.BACKSTORY_API_KEY! })
const { data: flows } = await backstory.listFlows()
const run = await backstory.runFlow(String((flows[0] as { id: string }).id), { accountId: '123' })
```

Keys are workspace-scoped and independently authorize `flows:read`, `flows:write`, and `flows:run`. Native imports use the versioned `backstory.flow.v1` contract.
