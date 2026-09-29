/**
 * Server-safe HTML detection for agent output — the same rules the client's
 * html-preview uses, in a leaf module the executor and services can import.
 */

const LEADING_TAG_PATTERN = /^<(!doctype|html|body|head|div|section|article|table|main|header|footer|h[1-6]|p|ul|ol|style)\b/i
const PAIRABLE_TAGS = ['html', 'body', 'div', 'section', 'article', 'table', 'main', 'header', 'footer', 'ul', 'ol', 'p', 'h1', 'h2', 'h3']

/** Tag-first content, or a matched open/close pair of a structural tag. */
export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('<') && LEADING_TAG_PATTERN.test(trimmed)) return true
  return PAIRABLE_TAGS.some((tag) => new RegExp(`<${tag}\\b`, 'i').test(trimmed) && new RegExp(`</${tag}\\s*>`, 'i').test(trimmed))
}

const LONE_FENCE_PATTERN = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i

/** A response that is one fenced block around HTML, unwrapped; anything else untouched. */
export function unwrapHtmlFence(value: string): string {
  const match = LONE_FENCE_PATTERN.exec(value.trim())
  const inner = match?.[1]?.trim()
  return inner && looksLikeHtml(inner) ? inner : value
}

/** The HTML document an agent answer holds, or null when the answer is prose. */
export function htmlDocumentOf(text: string): string | null {
  const content = unwrapHtmlFence(text).trim()
  return looksLikeHtml(content) ? content : null
}

/** A title for a report: its <title>, else its first heading, else null. */
export function htmlTitleOf(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  const raw = (title || heading || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return raw ? raw.slice(0, 160) : null
}
