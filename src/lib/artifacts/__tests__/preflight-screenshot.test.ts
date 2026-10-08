import test from 'node:test'
import assert from 'node:assert/strict'
import { captureArtifactScreenshot, validateArtifactRuntime } from '../preflight'

test('a passing validation returns the validator screenshot; capture reuses it, re-validates a stranger, and drops what is not a PNG', async () => {
  const keys = ['ARTIFACT_VALIDATOR_URL', 'ARTIFACT_VALIDATOR_TOKEN', 'ARTIFACT_RUNTIME_PREFLIGHT'] as const
  const saved = keys.map((key) => process.env[key])
  const originalFetch = globalThis.fetch
  const png = Buffer.from('not really a png, but base64 is what travels').toString('base64')
  const page = (tag: string) => `<html><body><h1>Shot ${tag}</h1><script>1</script></body></html>`
  try {
    delete process.env.ARTIFACT_RUNTIME_PREFLIGHT
    process.env.ARTIFACT_VALIDATOR_URL = 'https://validator.example'
    process.env.ARTIFACT_VALIDATOR_TOKEN = 'unit-test-token'
    let runs = 0
    globalThis.fetch = async () => { runs++; return Response.json({ ok: true, checks: ['startup'], screenshot: png }) }
    const result = await validateArtifactRuntime(page('a'))
    assert.equal(result.screenshot, png)
    assert.equal(await captureArtifactScreenshot(page('a')), png, 'the picture the validation took')
    assert.equal(runs, 1, 'no second browser run for the same content')
    assert.equal(await captureArtifactScreenshot(page('b')), png, 'content never validated here is captured through the validator')
    assert.equal(runs, 2)
    globalThis.fetch = async () => Response.json({ ok: true, screenshot: 'not base64 at all!' })
    assert.equal((await validateArtifactRuntime(page('c'))).screenshot, null, 'only a base64 payload is a screenshot')
    globalThis.fetch = async () => Response.json({ ok: true })
    assert.equal((await validateArtifactRuntime(page('d'))).screenshot, null, 'an older validator without screenshots still passes')
    assert.equal((await validateArtifactRuntime('# Plain Markdown needs no browser')).screenshot, null)
    globalThis.fetch = async () => Response.json({ ok: false, errors: ['broken startup'] })
    await assert.rejects(validateArtifactRuntime(page('e')), /broken startup/)
    for (const key of keys) delete process.env[key]
    assert.equal(await captureArtifactScreenshot(page('f')), null, 'no validator configured: no picture, no error')
  } finally {
    globalThis.fetch = originalFetch
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
  }
})
