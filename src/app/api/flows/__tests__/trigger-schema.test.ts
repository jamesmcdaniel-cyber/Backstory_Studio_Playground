import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/trigger'

// The App Router only allows route files to export the HTTP method handlers
// (Next.js build-time constraint — a named `triggerSchema` export there fails
// typegen), so this mirrors the create/update trigger schema in
// src/app/api/flows/route.ts, built from the same canonical FLOW_TRIGGER_TYPES
// the route imports — keeping the two in lockstep rather than duplicating the
// literal list.
const triggerSchema = z.object({ type: z.enum(FLOW_TRIGGER_TYPES).default('manual') }).passthrough()

test('the create/update trigger schema accepts every canonical trigger type, including the new event types', () => {
  for (const type of FLOW_TRIGGER_TYPES) {
    assert.equal(triggerSchema.safeParse({ type }).success, true, `expected "${type}" to be accepted`)
  }
  assert.equal(triggerSchema.safeParse({ type: 'not-a-real-type' }).success, false)
})

test('activity and slack triggers pass through their own config fields', () => {
  const activity = triggerSchema.safeParse({ type: 'activity', source: 'salesforce', kinds: ['opportunity.updated'] })
  assert.equal(activity.success, true)
  if (activity.success) assert.deepEqual(activity.data.kinds, ['opportunity.updated'])

  const slack = triggerSchema.safeParse({ type: 'slack', channelId: 'C0123', threadOnly: true })
  assert.equal(slack.success, true)
  if (slack.success) assert.equal(slack.data.channelId, 'C0123')
})
