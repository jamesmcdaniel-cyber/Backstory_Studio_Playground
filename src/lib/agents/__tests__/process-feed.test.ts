import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProcessTimeline, feedLabel, hasAgentWork, type TimelineItem } from '../process-feed'

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

test('a reply that only recalls memory and reads its own page is not agent work', () => {
  const memory: TimelineItem = { key: 'm', ts: 0, kind: 'memory', summary: 'Recalled 1 memory from previous runs.' }
  assert.equal(hasAgentWork([memory, toolItem('artifact.read_artifact'), toolItem('artifact.get_artifact'), toolItem('ask_user')]), false)
  assert.equal(hasAgentWork([]), false)
})

test('querying a data source, running code or editing the page is agent work', () => {
  assert.equal(hasAgentWork([toolItem('artifact.read_artifact'), toolItem('backstory.find_account', 'running')]), true)
  assert.equal(hasAgentWork([toolItem('artifact.edit_artifact', 'running')]), true)
  assert.equal(hasAgentWork([toolItem('code.run_code')]), true)
})
