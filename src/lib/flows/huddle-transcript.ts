/** The slice of a HuddleSegment row that assembly needs. */
export type TranscriptSegment = {
  speakerName: string
  text: string
  startedAt: Date
}

/**
 * Assembles per-client transcription segments into one speaker-labelled
 * transcript. Pure, so ordering, merging and fallback behaviour are testable
 * without a database.
 *
 * Adjacent segments from the same speaker merge into one block — each client
 * uploads every two minutes, so without merging a five-minute monologue would
 * render as three fragments interleaved with nobody.
 */
export function assembleTranscript(segments: TranscriptSegment[]): string {
  const ordered = segments
    .filter((segment) => segment.text.trim().length > 0)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())

  const blocks: { speaker: string; parts: string[] }[] = []
  for (const segment of ordered) {
    const speaker = segment.speakerName.trim() || 'Someone'
    const last = blocks[blocks.length - 1]
    if (last && last.speaker === speaker) last.parts.push(segment.text.trim())
    else blocks.push({ speaker, parts: [segment.text.trim()] })
  }
  return blocks.map((block) => `${block.speaker}: ${block.parts.join(' ')}`).join('\n\n')
}

/**
 * Prompt for the post-huddle summary. The response contract ({"summary",
 * "decisions"}) is asserted by tests because the summary endpoint parses
 * against exactly these keys.
 */
export function summaryPrompt(flowName: string, transcript: string): string {
  return [
    `A team just finished a voice huddle while editing the automation flow "${flowName}".`,
    'Below is the transcript, labelled by speaker. Write concise notes for the team.',
    '',
    'Reply with a single JSON object: {"summary": string, "decisions": string[]}.',
    '- summary: a short paragraph (3-5 sentences) of what was discussed, in plain language.',
    '- decisions: the concrete decisions or action items about the flow, one string each. Empty array if none.',
    'Mention step names as spoken. Do not invent decisions that were not discussed.',
    '',
    'TRANSCRIPT:',
    transcript,
  ].join('\n')
}
