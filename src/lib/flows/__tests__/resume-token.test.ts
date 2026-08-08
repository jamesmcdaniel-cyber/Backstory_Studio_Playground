import test from 'node:test'
import assert from 'node:assert/strict'
import { flowResumeToken, flowResumeTokenHash, flowResumeTokenValid } from '../resume-token'

test('resume capabilities are distinct from run ids and validate by hash', () => {
  const token = flowResumeToken('run-visible-id')
  const hash = flowResumeTokenHash('run-visible-id')
  assert.notEqual(token, 'run-visible-id')
  assert.equal(token.includes('run-visible-id'), false)
  assert.equal(flowResumeTokenValid('run-visible-id', token, hash), true)
  assert.equal(flowResumeTokenValid('run-visible-id', 'wrong', hash), false)
  assert.equal(flowResumeTokenValid('different-run', token, hash), false)
})
