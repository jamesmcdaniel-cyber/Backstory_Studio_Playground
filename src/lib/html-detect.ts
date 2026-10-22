/**
 * Server-safe HTML detection for agent output — the same rules the client's
 * html-preview uses, in a leaf module the executor and services can import.
 */

const LEADING_TAG_PATTERN = /^<(!doctype|html|body|head|div|section|article|table|main|header|footer|h[1-6]|p|ul|ol|style)\b/i
const PAIRABLE_TAGS = ['html', 'body', 'div', 'section', 'article', 'table', 'main', 'header', 'footer', 'ul', 'ol', 'p', 'h1', 'h2', 'h3']

/** Tag-first content, or a matched open/close pair of a structural tag. */
export function looksLikeHtml(value: string): boolean {
  // A document may open with a byte-order mark and comments (a banner, build
  // notes) before its doctype; they say nothing about what follows. A comment
  // still open at the end of the sample is a long banner on an HTML file.
  const stripped = value.replace(/^\uFEFF/, '').trimStart()
  if (stripped.startsWith('<!--') && !/^(?:\s*<!--[\s\S]*?-->)+/.test(stripped)) return true
  const trimmed = stripped.replace(/^(?:\s*<!--[\s\S]*?-->)+/, '').trim()
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

/**
 * Whether text IS an HTML document, from its first character to its last:
 * it opens with a doctype, <html>, <head> or <body> (after any comments), or
 * it opens with a structural tag and ends with a closing one. Prose or
 * Markdown that merely contains markup — an inline <p>, an embedded snippet —
 * is not; that is what `looksLikeHtml` (for rendering text already known to
 * be a page) is loose about.
 */
function isHtmlDocument(text: string): boolean {
  const stripped = text.replace(/^\uFEFF/, '').trimStart()
  // A comment still open at the end of the sample is a long banner on an HTML file.
  if (stripped.startsWith('<!--') && !/^(?:\s*<!--[\s\S]*?-->)+/.test(stripped)) return true
  const body = stripped.replace(/^(?:\s*<!--[\s\S]*?-->)+/, '').trim()
  if (/^<(?:!doctype|html|head|body)\b/i.test(body)) return true
  return LEADING_TAG_PATTERN.test(body) && /(?:<\/[a-z][\w-]*\s*>|-->)$/i.test(body)
}

// A short lead-in ("Here is the report:") and a short sign-off are allowed
// around the one fenced block; a longer explanation makes it an answer that
// shows code, not a deliverable.
const SOLE_FENCE_PATTERN = /^(?:[^\n`]{0,240}\n+)?[ \t]*```([a-z]*)[^\n]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?:\n+[^`]{0,240})?$/i

/** The one fenced block that makes up essentially the whole answer, with its language; null for anything else. */
export function soleFencedBlockOf(text: string): { lang: string; inner: string } | null {
  const match = SOLE_FENCE_PATTERN.exec(text.trim())
  return match ? { lang: match[1].toLowerCase(), inner: match[2].trim() } : null
}

/**
 * The HTML document an agent answer IS, or null when the answer is prose or
 * Markdown (whatever markup it shows): the answer itself, the one fenced
 * html block it consists of, or a document a short lead-in introduces.
 */
export function htmlDocumentOf(text: string): string | null {
  const content = text.trim()
  if (isHtmlDocument(content)) return content
  const fenced = soleFencedBlockOf(content)
  if (fenced) return /^(?:html?|xhtml|)$/.test(fenced.lang) && isHtmlDocument(fenced.inner) ? fenced.inner : null
  const lead = /^[^\n<`]{1,240}\n+\s*(?=<!doctype\b|<html\b)/i.exec(content)
  return lead ? content.slice(lead[0].length).trim() : null
}

/**
 * Whether HTML carries script that must run for it to work: a <script>, or an
 * inline event handler on a tag (onclick=…). Serving (which grants
 * allow-scripts) and the browser check decide on this one rule, so a page
 * whose buttons use handlers is neither served dead nor left unchecked.
 */
export function htmlHasScript(content: string): boolean {
  return /<script[\s>]|<[a-z][\w-]*(?:\s[^<>]*?)?\son[a-z]{3,}\s*=/i.test(content)
}

/** A title for a report: its <title>, else its first heading, else null. */
export function htmlTitleOf(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const heading = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]
  const raw = (title || heading || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return raw ? raw.slice(0, 160) : null
}

const HEADING = /^#{1,3} \S/m
/** Enough headed Markdown to be a document someone will keep, not a reply. */
export function markdownDocumentOf(text: string): string | null {
  const content = text.trim()
  if (htmlDocumentOf(content)) return null
  const headings = (content.match(/^#{1,3} \S/gm) ?? []).length
  if ((content.length >= 1_500 && headings >= 2) || (content.length >= 3_000 && HEADING.test(content))) return content
  return null
}

/** A Markdown document's title: its first heading. */
export function markdownTitleOf(text: string): string | null {
  const heading = /^#{1,3} (.+)$/m.exec(text)?.[1]
  const raw = heading?.replace(/[*_`]/g, '').trim()
  return raw ? raw.slice(0, 160) : null
}
