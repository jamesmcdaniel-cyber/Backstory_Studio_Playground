import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArtifactRuntime } from '../preflight'

test('runtime preflight fails closed, accepts explicit passes, and preserves validation errors', async () => {
  const keys = ['ARTIFACT_VALIDATOR_URL', 'ARTIFACT_VALIDATOR_TOKEN', 'ARTIFACT_RUNTIME_PREFLIGHT'] as const
  const saved = keys.map(key => process.env[key])
  const originalFetch = globalThis.fetch
  const source = '<html><body><h1>QA</h1><script>throw Error("broken startup")</script></body></html>'
  try {
    for (const key of keys) delete process.env[key]
    process.env.ARTIFACT_RUNTIME_PREFLIGHT = 'required'
    await assert.rejects(validateArtifactRuntime(source), /validation is unavailable/)
    await validateArtifactRuntime('# Plain Markdown needs no browser')
    process.env.ARTIFACT_VALIDATOR_URL = 'https://validator.example'
    process.env.ARTIFACT_VALIDATOR_TOKEN = 'unit-test-token'
    let posted = false
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://validator.example/validate')
      assert.equal(init?.redirect, 'error')
      assert.match(String(init?.body), /broken startup/)
      posted = true
      return Response.json({ ok: false, errors: ['broken startup'] })
    }
    await assert.rejects(validateArtifactRuntime(source), /broken startup.*current version was not changed/)
    assert.equal(posted, true)
    globalThis.fetch = async () => Response.json({ ok: true, checks: ['startup'] })
    await validateArtifactRuntime(source)
    let validations = 0
    globalThis.fetch = async () => { validations++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ ok: true }) }
    await Promise.all(Array.from({ length: 8 }, () => validateArtifactRuntime(source)))
    assert.equal(validations, 1, 'identical overlapping candidates share validation')
    await validateArtifactRuntime(source)
    assert.equal(validations, 2, 'a past success never skips a new validation')
    globalThis.fetch = async () => Response.json({ success: true })
    await assert.rejects(validateArtifactRuntime(source), /failed browser startup validation/)
    globalThis.fetch = async () => { throw new Error('network unavailable') }
    await assert.rejects(validateArtifactRuntime(source), /could not finish/)
  } finally {
    globalThis.fetch = originalFetch
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})
