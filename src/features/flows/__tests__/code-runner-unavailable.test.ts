import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * When the Python thread cannot start (here: `pyodide` does not resolve from
 * the working directory), callers learn the runtime is down. An artifact save
 * must read that as a retryable outage, never as a fault in the page's code.
 */

test('a Python runtime that cannot start is an outage, not a verdict on the code', async (t) => {
  const cwd = process.cwd()
  process.chdir('/')
  t.after(() => process.chdir(cwd))
  const { runFlowCode, PythonRuntimeUnavailableError } = await import('../code-runner')
  await assert.rejects(
    runFlowCode({ language: 'python', mode: 'all', code: 'return 1', input: null }),
    (error: unknown) => error instanceof PythonRuntimeUnavailableError,
  )
  const { validateArtifactPython } = await import('@/lib/artifacts/validate-content')
  await assert.rejects(
    validateArtifactPython('<script type="text/python">x = 1</script>'),
    (error: unknown) => error instanceof Error && error.name === 'ArtifactValidatorUnavailableError',
  )
})
