import { createHash } from 'node:crypto'
import { singleFlight } from '@/lib/single-flight'
import { apiLogger } from '@/lib/logger'

export type ArtifactPreflightResult = {
  /** A 1280×800 PNG of the page as it passed (base64), when the validator took one. */
  screenshot: string | null
}

const validateOnce = singleFlight<ArtifactPreflightResult>()

/**
 * The latest screenshot per content, kept in this process so the assistant's
 * view_artifact_screenshot can show the picture the save just produced
 * without a second browser run. A miss re-captures through the validator.
 */
const SCREENSHOTS = new Map<string, string>()
const SCREENSHOTS_MAX = 8
export function contentHashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
function rememberScreenshot(content: string, screenshot: string | null) {
  if (!screenshot) return
  const hash = contentHashOf(content)
  SCREENSHOTS.delete(hash)
  SCREENSHOTS.set(hash, screenshot)
  if (SCREENSHOTS.size > SCREENSHOTS_MAX) { const oldest = SCREENSHOTS.keys().next().value; if (oldest !== undefined) SCREENSHOTS.delete(oldest) }
}

/** The page's picture: the one its validation took, or a fresh capture (a validator run) when none is at hand. Null when the validator is not configured. */
export async function captureArtifactScreenshot(content: string): Promise<string | null> {
  const cached = SCREENSHOTS.get(contentHashOf(content))
  if (cached) return cached
  return (await validateArtifactRuntime(content)).screenshot
}

/**
 * The validator could not be asked, or did not answer in its protocol: a
 * network failure, a timeout, a non-2xx without a structured verdict, or a
 * body that is neither a pass nor a fail. Says nothing about the content —
 * callers must not present it as a content failure, or an assistant will
 * "fix" a healthy page.
 */
export class ArtifactValidatorUnavailableError extends Error {
  constructor() {
    super(ARTIFACT_VALIDATOR_UNAVAILABLE)
    this.name = 'ArtifactValidatorUnavailableError'
  }
}

export const ARTIFACT_VALIDATOR_UNAVAILABLE = 'The artifact validator is unavailable right now, so the save could not be checked. Retry in a minute; the current version was not changed.'

let warnedSkipped = false

/** Only overlapping identical validations share work. Never cache a past pass. */
export function validateArtifactRuntime(content: string): Promise<ArtifactPreflightResult> {
  const key = createHash('sha256').update(JSON.stringify([content, process.env.ARTIFACT_VALIDATOR_URL, process.env.ARTIFACT_VALIDATOR_TOKEN, process.env.ARTIFACT_RUNTIME_PREFLIGHT])).digest('hex')
  return validateOnce(key, async () => { const result = await validateRuntime(content); rememberScreenshot(content, result.screenshot); return result })
}

/** Browser startup gate. No generated code executes in the API or agent worker. */
async function validateRuntime(content: string): Promise<ArtifactPreflightResult> {
  const none: ArtifactPreflightResult = { screenshot: null }
  if (!/<script\b|<py-script\b|\bexport\s+default\b|\bon\w+\s*=/i.test(content)) return none
  const endpoint = process.env.ARTIFACT_VALIDATOR_URL
  const token = process.env.ARTIFACT_VALIDATOR_TOKEN
  if (!endpoint || !token) {
    if (process.env.ARTIFACT_RUNTIME_PREFLIGHT === 'required') throw new ArtifactValidatorUnavailableError()
    if (!warnedSkipped) {
      warnedSkipped = true
      apiLogger.warn('artifact runtime preflight skipped: ARTIFACT_VALIDATOR_URL / ARTIFACT_VALIDATOR_TOKEN are not set and ARTIFACT_RUNTIME_PREFLIGHT is not "required"; scripted artifacts are saved without a browser startup check')
    }
    return none
  }
  const url = new URL('/validate', endpoint)
  if (url.protocol !== 'https:') throw new Error('Artifact validator requires HTTPS.')
  const { artifactPageResponse } = await import('./serve')
  const html = await artifactPageResponse({ content, kind: 'page' }, 'http://artifact-runtime.invalid').text()
  const deadline = Date.now() + 150_000
  let retries = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ html }), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error' })
    } catch { throw new ArtifactValidatorUnavailableError() }
    if (response.status === 429 && Date.now() + 5000 < deadline) { await new Promise(resolve => setTimeout(resolve, Math.min(5000, 1000 * 2 ** retries++) + Math.random() * 250)); continue }
    const result = await response.json().catch(() => null) as { ok?: boolean; errors?: string[]; screenshot?: unknown } | null
    if (result?.ok === true && response.ok) {
      // Bounded: a PNG of a 1280×800 page is well under this; anything else is not a screenshot.
      const screenshot = typeof result.screenshot === 'string' && result.screenshot.length > 0 && result.screenshot.length <= 6_000_000 && /^[A-Za-z0-9+/=]+$/.test(result.screenshot) ? result.screenshot : null
      return { screenshot }
    }
    // A structured verdict is about the content, whatever the status code;
    // anything else (5xx, 429 past the deadline, a 200 that is not a verdict)
    // is the service, not the page.
    const verdict = result?.ok === false && Array.isArray(result.errors)
    if (!verdict) throw new ArtifactValidatorUnavailableError()
    const detail = result.errors!.slice(0, 3).map(value => String(value).slice(0, 500)).join('; ') || 'The page did not start.'
    throw new Error(`Artifact failed browser startup validation: ${detail} The current version was not changed. Fix the artifact and retry.`)
  }
}
