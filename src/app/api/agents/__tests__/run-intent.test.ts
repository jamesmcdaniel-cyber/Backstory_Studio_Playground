import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRunIntent, runIntentSchema } from '../[id]/chat/shared'

/**
 * Whether an assistant reply triggers an agent run. A false positive burns a
 * real run (tokens, tool side effects) on a question; a malformed shape must
 * degrade to "no run", never to a throw that kills the whole reply.
 *
 * Lives here rather than beside `shared.ts` for the same reason as the
 * proposal tests: a `[id]` path segment reads as a glob character to the
 * test runner and the file would be silently collected as zero tests.
 */

const shape = (raw: unknown) => normalizeRunIntent(runIntentSchema.catch(null).parse(raw))

test('a task runs, trimmed', () => {
  assert.deepEqual(shape({ task: '  Pull the top 10 at-risk accounts and summarize each.  ' }), {
    task: 'Pull the top 10 at-risk accounts and summarize each.',
  })
})

test('absent, null, or empty run intents stay null', () => {
  assert.equal(shape(undefined), null)
  assert.equal(shape(null), null)
  assert.equal(shape({}), null)
  assert.equal(shape({ task: '' }), null)
  assert.equal(shape({ task: '   ' }), null)
})

test('malformed shapes degrade to null instead of throwing', () => {
  assert.equal(shape('run it'), null)
  assert.equal(shape({ task: 42 }), null)
  assert.equal(shape([{ task: 'x' }]), null)
})
