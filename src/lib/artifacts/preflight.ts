/** Browser startup gate. No generated code executes in the API or agent worker. */
export async function validateArtifactRuntime(content: string): Promise<void> {
  if (!/<script\b|<py-script\b|\bexport\s+default\b|\bon\w+\s*=/i.test(content)) return
  const endpoint = process.env.ARTIFACT_VALIDATOR_URL
  const token = process.env.ARTIFACT_VALIDATOR_TOKEN
  if (!endpoint || !token) {
    if (process.env.ARTIFACT_RUNTIME_PREFLIGHT === 'required') throw new Error('Artifact browser validation is unavailable. The current version was not changed.')
    return
  }
  const url = new URL('/validate', endpoint)
  if (url.protocol !== 'https:') throw new Error('Artifact validator requires HTTPS.')
  const { artifactPageResponse } = await import('./serve')
  const html = await artifactPageResponse({ content, kind: 'page' }, 'http://artifact-runtime.invalid').text()
  const deadline = Date.now() + 100_000
  let retries = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ html }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error' })
    } catch { throw new Error('Artifact browser validation could not finish. Retry shortly; the current version was not changed.') }
    if (response.status === 429 && Date.now() + 5000 < deadline) { await new Promise(resolve => setTimeout(resolve, Math.min(5000, 1000 * 2 ** retries++) + Math.random() * 250)); continue }
    const result = await response.json().catch(() => null) as { ok?: boolean; errors?: string[] } | null
    if (!response.ok || result?.ok !== true) {
      const detail = Array.isArray(result?.errors) ? result.errors.slice(0, 3).map(value => String(value).slice(0, 500)).join('; ') : 'Validation service unavailable or busy.'
      throw new Error(`Artifact failed browser startup validation: ${detail} The current version was not changed. Fix the artifact and retry.`)
    }
    return
  }
}
