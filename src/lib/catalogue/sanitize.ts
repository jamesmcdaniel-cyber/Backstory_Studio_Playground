/**
 * Catalogue submission hygiene, applied at snapshot time.
 *
 * A different boundary from `publicFlowGraph` (src/lib/flows/public-graph.ts).
 * That one projects a flow for an ANONYMOUS viewer and blanks the functional
 * content — url, code, prompts — because a stranger needs to see shape, not
 * substance. A catalogue entry is the opposite: an authenticated person
 * installs and RUNS it, so the substance is the whole value. What must not
 * cross is narrower and more specific:
 *
 *  - Ids that only resolve inside the author's workspace. A `credentialId`
 *    pointing at their HttpCredential row is meaningless to an installer and
 *    discloses the author's inventory; installers re-bind their own auth
 *    (the import auto-bind path already does this).
 *  - Credentials typed literally into a step. Stripping cannot fix these —
 *    removing a bearer token would silently break the template — so they are
 *    REPORTED to the reviewer instead, who decides.
 *
 * Both functions are pure: no DB, no env, no clock.
 */

/**
 * Keys dropped wherever they appear, at any depth.
 *
 * Deliberately key-based rather than a per-node-type allowlist: the same ids
 * appear at different depths across the three submission kinds (a flow graph
 * node, an agent template's configuration, a skill's integrations), and a
 * miss here is an inert dangling id, not a disclosure of secret material —
 * the secret scan below is what guards the values that matter.
 */
const ORG_REFERENCE_KEYS = new Set([
  'credentialId',
  'connectionId',
  'connectionIds',
  'toolConnectionIds',
  'agentId',
  'flowId',
  'organizationId',
  'userId',
  'submittedByUserId',
])

/** Keys whose VALUE is expected to be secret material when it is a literal. */
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[-_]?key|apikey|auth|credential|bearer|private[-_]?key)/i

/** Literal credentials with a recognisable shape, whatever key they sit under. */
const SECRET_VALUE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: 'a private key' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i, reason: 'a literal Bearer token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, reason: 'an OpenAI-style secret key' },
  { pattern: /\bsk_(live|test)_[A-Za-z0-9]{16,}/, reason: 'a Stripe secret key' },
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, reason: 'a GitHub token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, reason: 'a GitHub fine-grained token' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, reason: 'a Slack token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: 'an AWS access key id' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, reason: 'a Google API key' },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/, reason: 'an Anthropic API key' },
]

/** Long opaque strings: only suspicious when the KEY says they are secret. */
const OPAQUE_VALUE = /^[A-Za-z0-9+/=._-]{24,}$/

export interface SecretFinding {
  /** Where it sits in the snapshot, e.g. `graph.nodes[3].data.headers.Authorization`. */
  path: string
  /** Plain-English description of what was matched. */
  reason: string
  /** Masked hint — enough to locate the value, never enough to use it. */
  preview: string
}

type Json = unknown

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A copy of `value` with every {@link ORG_REFERENCE_KEYS} entry removed at any
 * depth. Arrays keep their positions; nothing else is reshaped.
 */
export function stripOrgReferences<T extends Json>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripOrgReferences(entry)) as unknown as T
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (ORG_REFERENCE_KEYS.has(key)) continue
      out[key] = stripOrgReferences(entry)
    }
    return out as unknown as T
  }
  return value
}

/**
 * Mask a matched value: the first three characters locate it in the source,
 * the rest is replaced. Short values are masked entirely — for those, three
 * characters would be most of the secret.
 */
function maskValue(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (collapsed.length < 12) return `••• (${collapsed.length} chars)`
  return `${collapsed.slice(0, 3)}••• (${collapsed.length} chars)`
}

function scanString(path: string, key: string, raw: string, found: SecretFinding[]): void {
  // `{{step.token}}` is a REFERENCE resolved at run time, not a literal — the
  // whole point of the token syntax. Never report one as a leaked credential.
  if (raw.includes('{{')) return

  for (const { pattern, reason } of SECRET_VALUE_PATTERNS) {
    if (pattern.test(raw)) {
      found.push({ path, reason: `Looks like ${reason}.`, preview: maskValue(raw) })
      return
    }
  }

  if (SECRET_KEY_PATTERN.test(key) && OPAQUE_VALUE.test(raw.trim())) {
    found.push({
      path,
      reason: `"${key}" holds a long literal value rather than a reference.`,
      preview: maskValue(raw),
    })
  }
}

/**
 * Every literal credential the snapshot appears to carry.
 *
 * Advisory by design: a template demonstrating an authenticated call is
 * legitimate, so this informs the reviewer rather than blocking the author.
 * Returns findings in document order, capped so one pathological snapshot
 * cannot flood the review screen.
 */
export function findSecretCandidates(value: Json, limit = 50): SecretFinding[] {
  const found: SecretFinding[] = []

  const walk = (node: Json, path: string, key: string): void => {
    if (found.length >= limit) return
    if (typeof node === 'string') {
      scanString(path, key, node, found)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`, key))
      return
    }
    if (isPlainObject(node)) {
      for (const [childKey, entry] of Object.entries(node)) {
        walk(entry, path ? `${path}.${childKey}` : childKey, childKey)
      }
    }
  }

  walk(value, '', '')
  return found
}
