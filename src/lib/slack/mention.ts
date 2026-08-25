/**
 * Who was addressed, and what they were asked.
 *
 * Pure so every resolution rule is testable without a database or Slack. The
 * roster shape is deliberately minimal (id/name/roleLabel) rather than reusing
 * buildRoster's card types — the caller maps, and this module stays about
 * matching.
 */

export interface MentionAgent {
  id: string
  name: string
  roleLabel?: string | null
}

export type MentionResolution =
  | { kind: 'agent'; agent: MentionAgent; prompt: string }
  | { kind: 'ask'; candidates: MentionAgent[]; reason: 'no-name' | 'no-match' }
  | { kind: 'none' }

/**
 * Words that open a question rather than name a teammate. Without this, "What
 * changed on Acme?" in an unbound channel would be read as an attempt to
 * address someone called "What".
 */
const QUESTION_OPENERS = new Set([
  'what', 'why', 'who', 'when', 'where', 'how', 'can', 'could', 'would', 'should',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'please', 'hey', 'hi', 'hello',
  'give', 'show', 'tell', 'find', 'make', 'run', 'send', 'draft', 'summarize', 'summarise',
])

/**
 * Remove the bot's own mention, leaving what was actually said.
 *
 * Only the BOT's mention is stripped: another person's `<@U…>` is content
 * ("ask Dana too") and must survive into the prompt.
 */
export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Lowercase, strip punctuation, collapse whitespace — for comparison only. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Does `body` open with `label`? Returns the remaining prompt if so.
 *
 * Matched on the NORMALIZED forms but sliced from the ORIGINAL body by word
 * count, so stripping punctuation for comparison never mangles the prompt the
 * user actually typed.
 */
function matchLeading(body: string, label: string): string | null {
  const normalizedLabel = normalize(label)
  if (!normalizedLabel) return null
  const labelWords = normalizedLabel.split(' ')
  const bodyWords = body.split(/\s+/).filter(Boolean)
  if (bodyWords.length < labelWords.length) return null
  const leading = normalize(bodyWords.slice(0, labelWords.length).join(' '))
  if (leading !== normalizedLabel) return null
  return bodyWords.slice(labelWords.length).join(' ')
}

export function resolveMention(params: {
  text: string
  botUserId: string
  agents: MentionAgent[]
  boundAgentId?: string | null
}): MentionResolution {
  const { agents } = params
  // Nothing to offer and nothing to run. Asking "which teammate?" against an
  // empty roster would be a dead end.
  if (agents.length === 0) return { kind: 'none' }

  const body = stripBotMention(params.text, params.botUserId)

  // 1. An explicit name or role label wins over any binding.
  //    Longest label first, so "Spend review" is not shadowed by a teammate
  //    called "Spend".
  const labelled = agents
    .flatMap((agent) => [
      { agent, label: agent.name },
      ...(agent.roleLabel ? [{ agent, label: agent.roleLabel }] : []),
    ])
    .sort((a, b) => normalize(b.label).length - normalize(a.label).length)

  for (const { agent, label } of labelled) {
    const prompt = matchLeading(body, label)
    if (prompt !== null) return { kind: 'agent', agent, prompt }
  }

  // 2. A leading word that looks like an attempt to name someone, matching
  //    nothing, ASKS. Falling through to the channel default here would run a
  //    different teammate than the one the person named — worse than asking.
  const firstWord = body.split(/\s+/)[0] ?? ''
  const looksLikeAName =
    /^[A-Z][A-Za-z-]{1,}$/.test(firstWord.replace(/[^A-Za-z-]/g, '')) &&
    !QUESTION_OPENERS.has(normalize(firstWord))
  if (looksLikeAName) return { kind: 'ask', candidates: agents, reason: 'no-match' }

  // 3. The channel's default teammate.
  if (params.boundAgentId) {
    const bound = agents.find((agent) => agent.id === params.boundAgentId)
    // A binding whose agent is not in this roster asks rather than running
    // nothing silently.
    if (bound) return { kind: 'agent', agent: bound, prompt: body }
    return { kind: 'ask', candidates: agents, reason: 'no-name' }
  }

  // 4. Nothing named, no binding.
  return { kind: 'ask', candidates: agents, reason: 'no-name' }
}
