/** Strip a ```html / ```markdown fence an agent may wrap its answer in. Kept
 *  here (not in the client html-preview module) so server code can use it. */
export function unwrapHtmlFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```(?:html|markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return match ? match[1].trim() : trimmed
}
