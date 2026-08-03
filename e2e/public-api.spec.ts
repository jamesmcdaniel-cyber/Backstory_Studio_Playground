import { expect, test } from '@playwright/test'

test('native workflow package round-trips through the public API', async ({ request }) => {
  test.skip(!process.env.E2E_API_KEY, 'E2E_API_KEY is required for the authenticated portability suite.')
  const headers = { Authorization: `Bearer ${process.env.E2E_API_KEY}` }
  const created = await request.post('/api/v1/flows', {
    headers,
    data: { format: 'backstory.flow.v1', flow: { name: `E2E ${Date.now()}`, graph: { nodes: [], edges: [] } } },
  })
  expect(created.status()).toBe(201)
  const id = (await created.json()).data.id
  const loaded = await request.get(`/api/v1/flows/${id}`, { headers })
  expect(loaded.status()).toBe(200)
  expect((await loaded.json()).package.format).toBe('backstory.flow.v1')
  expect((await request.delete(`/api/v1/flows/${id}`, { headers })).status()).toBe(204)
})
