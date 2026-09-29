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
  assert.match(change, /COMPLETE revised HTML document/)
  assert.match(change, /REQUEST: Add a risks section/)
  assert.match(change, /<html><body>doc<\/body><\/html>/)
  const ask = buildArtifactPrompt({ mode: 'ask', title: 'Q3 review', content: 'doc', message: 'Why did it drop?', chat: [{ role: 'user', content: 'earlier', createdAt: 'x', status: 'completed' }, { role: 'agent', content: 'answer', createdAt: 'x', status: 'completed' }] })
  assert.match(ask, /Do not return the document/)
  assert.match(ask, /CONVERSATION SO FAR:\nUser: earlier\n\nYou: answer/)
  assert.match(ask, /QUESTION: Why did it drop\?/)
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
