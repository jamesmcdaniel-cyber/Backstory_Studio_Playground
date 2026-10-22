import { createHash } from 'node:crypto'
import { singleFlight } from '@/lib/single-flight'
import { apiLogger } from '@/lib/logger'
import { ArtifactContentError } from './validate-content'
import { htmlHasScript } from '@/lib/html-detect'

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
 * The validator could not be asked, did not answer in its protocol, or
 * failed itself: a network failure, a timeout, a 5xx, a body that is neither
 * a pass nor a fail, or the validator's own deadline, crash or capacity
 * (reported with `infra: true`). Says nothing about the content —
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

/**
 * The validator's request-body cap, shared with services/artifact-validator
 * (MAX_BODY_BYTES there). The body is the served page JSON-encoded: one
 * character can become six bytes (a control character's \\uXXXX), so the
 * largest page the size limits allow (an ROI dashboard), fully escaped, plus
 * the runtime the page is served with, fits.
 */
export const VALIDATOR_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * The validator's own failures, as a validator deployed before the `infra`
 * marker reported them: a 422 like a verdict. They say nothing about the page.
 */
const LEGACY_INFRA_ERROR = /exceeded the 45 second deadline|exited before reporting a result|must restart before UID reuse|^Payload too large|^browserType\.launch|^Artifact frame failed to load/i

export type ArtifactRuntimeCheck = {
  /**
   * The page must declare window.__artifactTests for its controls: asked of
   * agent-authored artifacts only. An upload, a code page or a platform page
   * is checked for startup alone.
   */
  declaredTests?: boolean
}

/** Only overlapping identical validations share work. Never cache a past pass. */
export function validateArtifactRuntime(content: string, check: ArtifactRuntimeCheck = {}): Promise<ArtifactPreflightResult> {
  const declaredTests = Boolean(check.declaredTests)
  const key = createHash('sha256').update(JSON.stringify([content, declaredTests, process.env.ARTIFACT_VALIDATOR_URL, process.env.ARTIFACT_VALIDATOR_TOKEN, process.env.ARTIFACT_RUNTIME_PREFLIGHT])).digest('hex')
  return validateOnce(key, async () => { const result = await validateRuntime(content, declaredTests); rememberScreenshot(content, result.screenshot); return result })
}

/** Browser startup gate. No generated code executes in the API or agent worker. */
async function validateRuntime(content: string, declaredTests: boolean): Promise<ArtifactPreflightResult> {
  const none: ArtifactPreflightResult = { screenshot: null }
  // What serving runs (see htmlHasScript), plus Python and React modules.
  if (!htmlHasScript(content) && !/<py-script\b|\bexport\s+default\b/i.test(content)) return none
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
  const body = JSON.stringify({ html, requireDeclaredTests: declaredTests })
  // Measured, not estimated: the page as it will be sent. Over the cap is
  // about the page (its size), said before anything is sent.
  const bytes = Buffer.byteLength(body)
  if (bytes > VALIDATOR_MAX_BODY_BYTES) {
    throw new ArtifactContentError(`Artifact is too large for the browser check (${(bytes / 1_048_576).toFixed(1)} MB encoded; the limit is ${VALIDATOR_MAX_BODY_BYTES / 1_048_576} MB), so nothing was saved. Split it into smaller artifacts or move bulky data out of the page.`)
  }
  const deadline = Date.now() + 150_000
  let retries = 0
  for (;;) {
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())), redirect: 'error' })
    } catch { throw new ArtifactValidatorUnavailableError() }
    if (response.status === 429 && Date.now() + 5000 < deadline) { await new Promise(resolve => setTimeout(resolve, Math.min(5000, 1000 * 2 ** retries++) + Math.random() * 250)); continue }
    const result = await response.json().catch(() => null) as { ok?: boolean; infra?: boolean; errors?: string[]; screenshot?: unknown } | null
    if (result?.ok === true && response.ok) {
      // Bounded: a PNG of a 1280×800 page is well under this; anything else is not a screenshot.
      const screenshot = typeof result.screenshot === 'string' && result.screenshot.length > 0 && result.screenshot.length <= 6_000_000 && /^[A-Za-z0-9+/=]+$/.test(result.screenshot) ? result.screenshot : null
      return { screenshot }
    }
    // A verdict is about the content: { ok: false, errors } on a 200 or a 422.
    // Anything else is the service, not the page — a 5xx or 413, 429 past
    // the deadline, a body that is not a verdict, the validator's own failure
    // (marked infra, or named in a legacy 422) — so nothing "fixes" a healthy page.
    const verdict = result?.ok === false && Array.isArray(result.errors) && (response.status === 200 || response.status === 422)
    const infra = result?.infra === true || (Array.isArray(result?.errors) && result.errors.some(error => LEGACY_INFRA_ERROR.test(String(error))))
    if (!verdict || infra) throw new ArtifactValidatorUnavailableError()
    const detail = result.errors!.slice(0, 3).map(value => String(value).slice(0, 500)).join('; ') || 'The page did not start.'
    throw new ArtifactContentError(`Artifact failed browser startup validation: ${detail} The current version was not changed. Fix the artifact and retry.`)
  }
}
