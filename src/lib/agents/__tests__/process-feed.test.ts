import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProcessTimeline, feedLabel, type TimelineItem } from '../process-feed'

function toolItem(node: string, status = 'succeeded'): TimelineItem {
  return { key: 'k', ts: 0, kind: 'tool', step: { id: 's', node, status } }
}

test('drops the internal plane prefix from tool labels', () => {
  assert.equal(feedLabel(toolItem('nango:slack.send_message', 'running')), 'Calling send message in Slack')
})

test('names the provider once when the tool name repeats it', () => {
  assert.equal(feedLabel(toolItem('nango:gmail.gmail_send_email')), 'Finished send email in Gmail')
  assert.equal(feedLabel(toolItem('nango:salesforce.salesforce_update_record', 'failed')), 'Call to update record in Salesforce failed')
})

test('multi-dot tool paths read as words', () => {
  assert.equal(feedLabel(toolItem('google.calendar.create_event')), 'Finished calendar create event in Google')
})

test('provider-less tools still humanize', () => {
  assert.equal(feedLabel(toolItem('web_search', 'waiting')), 'Waiting on web search')
})

test('ask_user keeps its own copy', () => {
  assert.equal(feedLabel(toolItem('ask_user', 'succeeded')), 'Got your answer')
  assert.equal(feedLabel(toolItem('ask_user', 'running')), 'Asking you a question')
})

test('knowledge events land on the timeline with their cited documents', () => {
  const { items } = buildProcessTimeline(
    [
      { id: 'e1', kind: 'knowledge.available', ts: '2026-09-02T10:00:00Z', payload: { summary: 'Offered 3 repository document(s).', files: ['journey.md'] } },
      { id: 'e2', kind: 'knowledge.retrieved', ts: '2026-09-02T10:00:05Z', payload: { summary: 'Retrieved from 1 repository document(s).', documents: [{ id: 'd1', filename: 'journey.md' }] } },
    ] as never,
    [],
  )
  const knowledge = items.filter((item) => item.kind === 'knowledge')
  assert.equal(knowledge.length, 2)
  assert.match((knowledge[0] as { summary: string }).summary, /Offered 3/)
  assert.deepEqual((knowledge[1] as { documents: unknown }).documents, [{ id: 'd1', filename: 'journey.md' }])
})
