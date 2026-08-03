'use client'

import { useRef, useState } from 'react'
import { Check, Code2, Copy, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Tag names whose presence signals a genuine HTML document/fragment rather
 * than prose with an occasional inline tag (e.g. a lone `<br>`). Kept
 * conservative on purpose: markdown output must never trip this.
 */
const STRUCTURAL_TAGS = ['!doctype', 'html', 'table', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'section', 'body']
const LEADING_TAG_PATTERN = new RegExp(`<(${STRUCTURAL_TAGS.join('|')})\\b`, 'i')
// `!doctype` has no closing tag, so the paired-tag fallback below excludes it.
const PAIRABLE_TAGS = STRUCTURAL_TAGS.filter((tag) => tag !== '!doctype')

/**
 * True when `value` looks like an HTML document or fragment (as opposed to
 * markdown or prose that merely contains a stray tag like `<br>`).
 *
 * Two ways in:
 *  1. The trimmed content starts with `<` and that leading tag is one of the
 *     structural tags above (`<!doctype`, `<html>`, `<div>`, `<table>`, …).
 *  2. The content isn't tag-first, but it contains a matched opening AND
 *     closing pair for the same structural tag (HTML embedded mid-text).
 *     A single unmatched tag (e.g. "Use <br> to break lines") never matches.
 */
export function looksLikeHtml(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('<') && LEADING_TAG_PATTERN.test(trimmed)) return true
  return PAIRABLE_TAGS.some((tag) => {
    const openPattern = new RegExp(`<${tag}\\b`, 'i')
    const closePattern = new RegExp(`</${tag}\\s*>`, 'i')
    return openPattern.test(trimmed) && closePattern.test(trimmed)
  })
}

/** A response that is nothing but one fenced block, e.g. ```html … ``` */
const LONE_FENCE_PATTERN = /^```[a-z]*\s*\n([\s\S]*?)\n?```$/i

/**
 * Unwraps a response that is a single fenced code block around HTML. Models
 * asked for a raw HTML report sometimes fence it out of habit; without this the
 * report still renders but carries stray ``` markers. Anything else — prose
 * around a fence, a fence holding non-HTML — is returned untouched, so real
 * code blocks keep rendering as code.
 */
export function unwrapHtmlFence(value: string): string {
  const match = LONE_FENCE_PATTERN.exec(value.trim())
  const inner = match?.[1]?.trim()
  return inner && looksLikeHtml(inner) ? inner : value
}

const PREVIEW_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:"
const PREVIEW_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`

/** Wrap agent HTML and put the restrictive policy before authored markup. */
export function toPreviewDocument(html: string): string {
  // Script-less sandboxing still permits images/styles to make requests. A
  // prompt injection could otherwise encode private flow data into a URL.
  if (/<html[\s>]/i.test(html)) {
    const withoutDoctype = html.replace(/^\s*<!doctype[^>]*>/i, '')
    return `<!doctype html>${PREVIEW_CSP_META}${withoutDoctype}`
  }
  return `<!doctype html><html><head>${PREVIEW_CSP_META}<meta charset="utf-8"><style>body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;color:#1f2937;font-size:14px;line-height:1.55;word-break:break-word}</style></head><body>${html}</body></html>`
}

// Auto-size bounds: a report shorter than the collapse limit renders at its
// natural height with no chrome; anything taller starts collapsed at the
// limit with an Expand toggle up to the ceiling (then scrolls internally).
const COLLAPSE_LIMIT = 1400
const MAX_AUTO_HEIGHT = 8000
// Fallbacks when measurement is unavailable (iframe not yet loaded).
const FALLBACK_COLLAPSED = 320
const FALLBACK_EXPANDED = 1000

/**
 * Renders agent-produced HTML (e.g. a report or email-brief body) as actual
 * formatted markup instead of raw text — without pulling in a sanitizer
 * dependency.
 *
 * Safety: the iframe's sandbox has NO `allow-scripts`, so any `<script>`,
 * inline event handler, or `javascript:` link in the agent's HTML simply does
 * not execute. `allow-same-origin` is granted ONLY so the PARENT can reach
 * `iframe.contentDocument` and measure the rendered height to auto-size the
 * frame — the framed content itself can run no code to abuse that origin
 * (no forms, no popups, no navigation either).
 *
 * SECURITY INVARIANT: never add `allow-scripts` here. Combining it with
 * `allow-same-origin` would let agent-authored HTML execute with the app's
 * origin (cookies, storage, DOM) — a full sandbox escape.
 */
export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  const [measured, setMeasured] = useState<number | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // Measure on load, then re-measure shortly after: grid/table layout can
  // settle a frame late, and a stale short height would clip the report.
  const measure = () => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    const next = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0)
    if (next > 0) setMeasured(Math.min(next + 2, MAX_AUTO_HEIGHT))
  }
  const onLoad = () => {
    measure()
    window.setTimeout(measure, 250)
    window.setTimeout(measure, 1000)
  }

  const needsToggle = measured === null || measured > COLLAPSE_LIMIT
  const height = measured === null
    ? (expanded ? FALLBACK_EXPANDED : FALLBACK_COLLAPSED)
    : expanded || measured <= COLLAPSE_LIMIT
      ? measured
      : COLLAPSE_LIMIT

  const copyHtml = async () => {
    try {
      await navigator.clipboard.writeText(html)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className={cn('min-h-[120px] w-full', className)}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="mono-label text-gray-400">Rendered output</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyHtml}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Copy the HTML source"
          >
            {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy HTML'}
          </button>
          <button
            type="button"
            onClick={() => setShowRaw((value) => !value)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {showRaw ? <Eye className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {showRaw ? 'Rendered' : 'Raw'}
          </button>
        </span>
      </div>

      {showRaw ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          {html}
        </pre>
      ) : (
        <>
          <iframe
            ref={iframeRef}
            title="Agent HTML output"
            srcDoc={toPreviewDocument(html)}
            sandbox="allow-same-origin"
            onLoad={onLoad}
            scrolling={height >= (measured ?? Number.POSITIVE_INFINITY) ? 'no' : 'yes'}
            className={cn('w-full rounded-lg border border-border bg-white', !expanded && 'overflow-hidden')}
            style={{ height }}
          />
          {needsToggle && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="mt-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
