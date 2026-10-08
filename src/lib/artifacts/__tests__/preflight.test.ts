import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactValidatorUnavailableError, validateArtifactRuntime } from '../preflight'

test('runtime preflight fails closed, accepts explicit passes, and preserves validation errors', async () => {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  const keys = ['ARTIFACT_VALIDATOR_URL', 'ARTIFACT_VALIDATOR_TOKEN', 'ARTIFACT_RUNTIME_PREFLIGHT'] as const
  const saved = keys.map(key => process.env[key])
  const originalFetch = globalThis.fetch
  const source = '<html><body><h1>QA</h1><script>throw Error("broken startup")</script></body></html>'
  try {
    for (const key of keys) delete process.env[key]
    // Skipped (not required, not configured): logged once per process, at warn.
    await validateArtifactRuntime(source)
    await validateArtifactRuntime(source + '<!-- again -->')
    assert.equal(warnings.filter((line) => /preflight skipped/.test(line)).length, 1)
    process.env.ARTIFACT_RUNTIME_PREFLIGHT = 'required'
    await assert.rejects(validateArtifactRuntime(source), /validator is unavailable/)
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
    // Not a verdict: a 200 that is not in the protocol, a 5xx, a 4xx without
    // errors, and a network failure are the service being unavailable — never
    // reported as the page failing, so nothing "fixes" a healthy page.
    const unavailable = (error: unknown) => error instanceof ArtifactValidatorUnavailableError && /validator is unavailable.*retry in a minute/i.test(error.message)
    globalThis.fetch = async () => Response.json({ success: true })
    await assert.rejects(validateArtifactRuntime(source), unavailable)
    globalThis.fetch = async () => Response.json({ error: 'boom' }, { status: 503 })
    await assert.rejects(validateArtifactRuntime(source), unavailable)
    globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 502 })
    await assert.rejects(validateArtifactRuntime(source), unavailable)
    globalThis.fetch = async () => { throw new Error('network unavailable') }
    await assert.rejects(validateArtifactRuntime(source), unavailable)
    // A structured verdict on a non-2xx is still about the content.
    globalThis.fetch = async () => Response.json({ ok: false, errors: ['ReferenceError: x'] }, { status: 422 })
    await assert.rejects(validateArtifactRuntime(source), (error: unknown) => !(error instanceof ArtifactValidatorUnavailableError) && /ReferenceError: x.*Fix the artifact/.test(String((error as Error).message)))
  } finally {
    console.warn = originalWarn
    globalThis.fetch = originalFetch
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})

test('an ROI dashboard may be several MB (platform-rendered data); anything else keeps the 2 MB guard', async () => {
  const { maxArtifactCharsFor, validateArtifactContent, MAX_ARTIFACT_CHARS } = await import('../validate-content')
  const big = `<!DOCTYPE html><html><body><script>const DATA = ${JSON.stringify('x'.repeat(3_000_000))};</script></body></html>`
  assert.doesNotThrow(() => validateArtifactContent(big, maxArtifactCharsFor('roi_dashboard')))
  assert.throws(() => validateArtifactContent(big, maxArtifactCharsFor('page')), /exceeds 2000000 characters/)
  assert.equal(maxArtifactCharsFor(null), MAX_ARTIFACT_CHARS)
})
