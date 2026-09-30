import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlDocumentOf, htmlTitleOf, looksLikeHtml } from '@/lib/html-detect'
import { buildArtifactPrompt, flowIdFromTrigger, isInteractiveKind } from '../service'

test('an HTML answer is detected whether fenced or bare; prose is not', () => {
  const doc = '<!doctype html><html><head><title>Q3 pipeline review</title></head><body><h1>Q3</h1></body></html>'
  assert.equal(htmlDocumentOf(doc), doc)
  assert.equal(htmlDocumentOf('```html\n' + doc + '\n```'), doc)
  assert.equal(htmlDocumentOf('Use <br> to break lines, then run it.'), null)
  assert.equal(htmlDocumentOf('## Summary\n\nWin rate rose.'), null)
  assert.equal(looksLikeHtml('<div class="report"><p>hi</p></div>'), true)
})

test('a title comes from <title>, then <h1>, else nothing', () => {
  assert.equal(htmlTitleOf('<html><head><title> Q3 <em>pipeline</em> review </title></head></html>'), 'Q3 pipeline review')
  assert.equal(htmlTitleOf('<div><h1>Account plan</h1></div>'), 'Account plan')
  assert.equal(htmlTitleOf('<div><p>no heading</p></div>'), null)
})

test('the producing flow is read from either trigger shape', () => {
  assert.equal(flowIdFromTrigger({ type: 'flow', flowId: 'f1' }), 'f1')
  assert.equal(flowIdFromTrigger({ type: 'subflow', parentFlowId: 'f2', parentRunId: 'r' }), 'f2')
  assert.equal(flowIdFromTrigger({ type: 'manual' }), null)
  assert.equal(flowIdFromTrigger(null), null)
})

test('a change request demands the whole revised document; a question forbids it', () => {
  const change = buildArtifactPrompt({ mode: 'change', title: 'Q3 review', content: '<html><body>doc</body></html>', message: 'Add a risks section', chat: [] })
  assert.match(change, /COMPLETE revised document/)
  assert.match(change, /as HTML/)
  assert.match(change, /revise_artifact/)
  assert.match(change, /MESSAGE: Add a risks section\n\(The user marked this as a change request\.\)/)
  assert.match(change, /<html><body>doc<\/body><\/html>/)
  const ask = buildArtifactPrompt({ mode: 'ask', title: 'Q3 review', content: 'doc', message: 'Why did it drop?', chat: [{ role: 'user', content: 'earlier', createdAt: 'x', status: 'completed' }, { role: 'agent', content: 'answer', createdAt: 'x', status: 'completed' }] })
  assert.match(ask, /Do not return the document/)
  assert.match(ask, /CONVERSATION SO FAR:\nUser: earlier\n\nYou: answer/)
  assert.match(ask, /MESSAGE: Why did it drop\?/)
})

test('a very long document is truncated with a marker, not dropped', () => {
  const long = '<div>' + 'x'.repeat(200_000) + '</div>'
  const prompt = buildArtifactPrompt({ mode: 'ask', title: 't', content: long, message: 'q', chat: [] })
  assert.match(prompt, /truncated: the document continues/)
  assert.ok(prompt.length < 130_000)
})

test('only the ROI dashboard kind runs scripts', () => {
  assert.equal(isInteractiveKind('roi_dashboard'), true)
  assert.equal(isInteractiveKind('report'), false)
})

test('headed Markdown of document length registers; a short reply does not', async () => {
  const { markdownDocumentOf, markdownTitleOf } = await import('@/lib/html-detect')
  const doc = '# Account plan: Acme\n\n' + 'Context paragraph. '.repeat(60) + '\n\n## Risks\n\n' + 'Risk detail. '.repeat(60)
  assert.equal(markdownDocumentOf(doc), doc.trim())
  assert.equal(markdownTitleOf(doc), 'Account plan: Acme')
  assert.equal(markdownDocumentOf('## Summary\n\nWin rate rose 4 points.'), null)
  assert.equal(markdownDocumentOf('x'.repeat(5_000)), null) // long, but no heading: a transcript, not a document
  assert.equal(markdownDocumentOf('<html><body>' + 'x'.repeat(2_000) + '</body></html>'), null) // HTML is the other path
})

test('a change to a Markdown document asks for Markdown back', () => {
  const prompt = buildArtifactPrompt({ mode: 'change', title: 'Plan', content: '# Plan\n\nbody', message: 'Add a timeline', chat: [] })
  assert.match(prompt, /as Markdown in the same structure/)
  assert.doesNotMatch(prompt, /as HTML/)
})

test('an ROI dashboard prompt never carries the page, and routes the three intents to tools', () => {
  const prompt = buildArtifactPrompt({ mode: 'auto', kind: 'roi_dashboard', title: 'ROI analysis · Iron Mountain', content: '<html>' + 'x'.repeat(2_000_000) + '</html>', message: 'Show me this for Acme and drop the adoption tab', chat: [] })
  assert.ok(prompt.length < 5_000)
  assert.match(prompt, /update_roi_dashboard/)
  assert.match(prompt, /start_roi_analysis/)
  assert.match(prompt, /list_roi_accounts/)
  assert.match(prompt, /Never write or return HTML/)
  // Live questions go to the sources that powered the artifact, through the agent.
  assert.match(prompt, /Sales AI \/ Backstory MCP/)
  assert.match(prompt, /MESSAGE: Show me this for Acme and drop the adoption tab$/)
})
