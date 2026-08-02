import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleTranscript, summaryPrompt, type TranscriptSegment } from '../huddle-transcript'

const seg = (speakerName: string, text: string, startedAt: string): TranscriptSegment => ({
  speakerName,
  text,
  startedAt: new Date(startedAt),
})

test('segments are ordered by time and labelled by speaker', () => {
  const out = assembleTranscript([
    seg('Bo', 'then we retry', '2026-08-01T10:02:00Z'),
    seg('Ada', 'add a slack step', '2026-08-01T10:00:00Z'),
  ])
  assert.equal(out, 'Ada: add a slack step\n\nBo: then we retry')
})

test('adjacent segments from the same speaker merge into one block', () => {
  const out = assembleTranscript([
    seg('Ada', 'first thought.', '2026-08-01T10:00:00Z'),
    seg('Ada', 'second thought.', '2026-08-01T10:02:00Z'),
    seg('Bo', 'reply.', '2026-08-01T10:03:00Z'),
  ])
  assert.equal(out, 'Ada: first thought. second thought.\n\nBo: reply.')
})

test('blank and whitespace-only segments are dropped', () => {
  const out = assembleTranscript([
    seg('Ada', '   ', '2026-08-01T10:00:00Z'),
    seg('Bo', 'real content', '2026-08-01T10:01:00Z'),
    seg('Ada', '', '2026-08-01T10:02:00Z'),
  ])
  assert.equal(out, 'Bo: real content')
})

test('a missing speaker name falls back rather than rendering a blank label', () => {
  const out = assembleTranscript([seg('  ', 'hello', '2026-08-01T10:00:00Z')])
  assert.equal(out, 'Someone: hello')
})

test('empty input assembles to an empty string', () => {
  assert.equal(assembleTranscript([]), '')
})

test('the summary prompt carries the flow name and the transcript', () => {
  const prompt = summaryPrompt('Weekly rollup', 'Ada: add a slack step')
  assert.match(prompt, /Weekly rollup/)
  assert.match(prompt, /Ada: add a slack step/)
  // Guard the contract the endpoint parses against.
  assert.match(prompt, /"summary"/)
  assert.match(prompt, /"decisions"/)
})

test('the prompt never uses raw token syntax', () => {
  assert.ok(!/\{\{|\}\}/.test(summaryPrompt('Flow', 'text')))
})
